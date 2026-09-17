import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph, type BaseCheckpointSaver, type BaseStore } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { ActionLog } from "../../actions/actionLog.js";
import type { FarcasterGateway } from "../../farcaster/farcasterGateway.js";
import type { FarcasterReader } from "../../farcaster/neynarReader.js";
import { extractInvaderIds, formatInvaderId } from "../../invaders/invaderId.js";
import { contentText } from "../../llm/jsonReply.js";
import type { LanguageModelFactory } from "../../llm/languageModelFactory.js";
import type { AgentMemory } from "../../memory/agentMemory.js";
import { buildSystemPrompt } from "../../persona/flashcastrPersona.js";
import type { CastValidator } from "../../validation/castValidator.js";
import { ConversationState, type ConversationStateType } from "./conversationState.js";
import { conversationTaskPrompt, threadContextMessage } from "./conversationPrompt.js";
import type { ConversationTools } from "./conversationTools.js";

export interface ConversationGraphDependencies {
  readonly reader: FarcasterReader;
  readonly memory: AgentMemory;
  readonly models: LanguageModelFactory;
  readonly tools: ConversationTools;
  readonly validator: CastValidator;
  readonly farcaster: FarcasterGateway;
  readonly actionLog: ActionLog;
  readonly checkpointer: BaseCheckpointSaver;
  readonly store: BaseStore;
  readonly clock?: () => Date;
}

const MAX_REPLY_ATTEMPTS = 3;
const MAX_TOOL_ROUNDS = 6;

function evidenceInvaderIds(messages: readonly BaseMessage[], inboundText: string): Set<string> {
  const evidence = [inboundText, ...messages.filter((message) => message instanceof ToolMessage || message instanceof HumanMessage).map(contentText)];
  return new Set(evidence.flatMap((text) => extractInvaderIds(text).map(formatInvaderId)));
}

function toolRoundsSoFar(messages: readonly BaseMessage[]): number {
  return messages.filter((message) => message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0).length;
}

export function buildConversationGraph(deps: ConversationGraphDependencies) {
  const clock = deps.clock ?? (() => new Date());
  const actor = "conversation";
  const baseModel = deps.models.create("converse");
  if (!baseModel.bindTools) throw new Error("conversation model must support tool calling");
  const model = baseModel.bindTools(deps.tools);
  const toolNode = new ToolNode(deps.tools);

  const loadContext = async (state: ConversationStateType) => {
    const messages: BaseMessage[] = [];
    if (!state.contextLoaded && state.inbound.kind === "reply") {
      try {
        const lines = await deps.reader.fetchThreadContext(state.inbound.threadHash);
        if (lines.length > 0) messages.push(new HumanMessage(threadContextMessage(lines)));
      } catch {
        messages.push(new HumanMessage("Thread context unavailable."));
      }
    }
    messages.push(new HumanMessage(`@${state.inbound.authorUsername}: ${state.inbound.text}`));
    await deps.memory.rememberUser(state.inbound.authorFid, state.inbound.authorUsername);
    return { messages, contextLoaded: true, draft: null, validation: null, attempts: 0, published: null };
  };

  const agent = async (state: ConversationStateType) => {
    const [corrections, knownUser] = await Promise.all([deps.memory.corrections(), deps.memory.knownUser(state.inbound.authorFid)]);
    const task = conversationTaskPrompt({ inbound: state.inbound, corrections, knownUser, today: clock().toISOString().slice(0, 10) });
    const reply = await model.invoke([new SystemMessage(buildSystemPrompt(task)), ...state.messages]);
    return { messages: [reply] };
  };

  const validate = async (state: ConversationStateType) => {
    const last = state.messages.at(-1);
    const draft = last ? contentText(last).trim() : "";
    const verdict = deps.validator.validate({ text: draft, allowedInvaderIds: evidenceInvaderIds(state.messages, state.inbound.text) });
    const attempts = state.attempts + 1;
    await deps.actionLog.record({ actor, action: "validate_reply", outcome: verdict.ok ? "ok" : "failed", threadId: state.inbound.threadHash, subject: state.inbound.hash, detail: { attempt: attempts, reasons: verdict.reasons, text: draft } });
    if (verdict.ok) return { draft, validation: verdict, attempts };
    return { messages: [new HumanMessage(`Editor note: ${verdict.reasons.join("; ")}. Rewrite your reply and send only the final text.`)], validation: verdict, attempts };
  };

  const publish = async (state: ConversationStateType) => {
    if (!state.draft) throw new Error("publish reached without a draft");
    const published = await deps.farcaster.publishCast({ text: state.draft, replyTo: { fid: state.inbound.authorFid, hash: state.inbound.hash } });
    await deps.farcaster.likeCast({ fid: state.inbound.authorFid, hash: state.inbound.hash }).catch(() => undefined);
    return { published };
  };

  const giveUp = async (state: ConversationStateType) => {
    await deps.actionLog.record({ actor, action: "reply_skipped", outcome: "skipped", threadId: state.inbound.threadHash, subject: state.inbound.hash, detail: { reasons: state.validation?.reasons ?? [] } });
    return {};
  };

  const afterAgent = (state: ConversationStateType) => {
    const last = state.messages.at(-1);
    const wantsTools = last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0;
    if (wantsTools && toolRoundsSoFar(state.messages) <= MAX_TOOL_ROUNDS) return "tools";
    return "validate";
  };
  const afterValidate = (state: ConversationStateType) => {
    if (state.validation?.ok) return "publish";
    return state.attempts < MAX_REPLY_ATTEMPTS ? "agent" : "giveUp";
  };

  return new StateGraph(ConversationState)
    .addNode("loadContext", loadContext)
    .addNode("agent", agent)
    .addNode("tools", toolNode)
    .addNode("validate", validate)
    .addNode("publish", publish)
    .addNode("giveUp", giveUp)
    .addEdge(START, "loadContext")
    .addEdge("loadContext", "agent")
    .addConditionalEdges("agent", afterAgent, { tools: "tools", validate: "validate" })
    .addEdge("tools", "agent")
    .addConditionalEdges("validate", afterValidate, { publish: "publish", agent: "agent", giveUp: "giveUp" })
    .addEdge("publish", END)
    .addEdge("giveUp", END)
    .compile({ checkpointer: deps.checkpointer, store: deps.store });
}

export type ConversationGraph = ReturnType<typeof buildConversationGraph>;
