import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { END, Send, START, StateGraph, type BaseCheckpointSaver, type BaseStore } from "@langchain/langgraph";
import { z } from "zod";
import { errorMessage, type ActionLog } from "../../actions/actionLog.js";
import type { FarcasterGateway } from "../../farcaster/farcasterGateway.js";
import { extractInvaderIds, formatInvaderId } from "../../invaders/invaderId.js";
import type { InvaderNewsFeed, InvaderStatusLookup } from "../../invaders/invaderSpotterClient.js";
import type { InvaderNewsEvent } from "../../invaders/newsPageParser.js";
import type { LanguageModelFactory } from "../../llm/languageModelFactory.js";
import { parseJsonReply } from "../../llm/jsonReply.js";
import type { AgentMemory } from "../../memory/agentMemory.js";
import { buildSystemPrompt } from "../../persona/flashcastrPersona.js";
import type { SourceRegistry } from "../../sources/sourceRegistry.js";
import type { CastValidator } from "../../validation/castValidator.js";
import { digestTaskPrompt } from "./digestPrompt.js";
import { DigestState, type DigestStateType } from "./digestState.js";

export interface DigestGraphDependencies {
  readonly spotter: InvaderNewsFeed & InvaderStatusLookup;
  readonly sources: SourceRegistry;
  readonly memory: AgentMemory;
  readonly models: LanguageModelFactory;
  readonly validator: CastValidator;
  readonly farcaster: FarcasterGateway;
  readonly actionLog: ActionLog;
  readonly channelId: string;
  readonly checkpointer: BaseCheckpointSaver;
  readonly store: BaseStore;
}

const EVENT_WINDOW_DAYS = 2;
const MAX_HEADLINE_LOOKUPS = 6;
const MAX_COMPOSE_ATTEMPTS = 3;
const PREVIOUS_DIGESTS_SHOWN = 5;

const draftSchema = z.object({ text: z.string().min(1), embedUrl: z.string().url().nullable().optional() });

function withinWindow(event: InvaderNewsEvent, date: string): boolean {
  const cutoff = new Date(date);
  cutoff.setUTCDate(cutoff.getUTCDate() - EVENT_WINDOW_DAYS);
  return new Date(event.date).getTime() >= cutoff.getTime();
}

function allowedEmbeds(state: DigestStateType): Set<string> {
  return new Set(state.newsItems.map((item) => item.url));
}

export function buildDigestGraph(deps: DigestGraphDependencies) {
  const actor = "digest";

  const checkAlreadyPublished = async (state: DigestStateType) => {
    const existing = await deps.memory.digestFor(state.date);
    if (!existing) return { sourceLabels: deps.sources.labels() };
    return { skippedReason: `digest for ${state.date} already published as ${existing.castHash}` };
  };

  const fetchSpotterNews = async (state: DigestStateType) => {
    const events = (await deps.spotter.fetchNewsEvents()).filter((event) => withinWindow(event, state.date));
    await deps.actionLog.record({ actor, action: "fetch_spotter_news", outcome: "ok", threadId: state.date, detail: { events: events.length } });
    return { events };
  };

  const lookupHeadlineStatuses = async (state: DigestStateType) => {
    const ids = [...new Map(state.events.map((event) => [event.displayId, event.id])).values()].slice(0, MAX_HEADLINE_LOOKUPS);
    if (ids.length === 0) return { headlineStatuses: [] };
    try {
      const statuses = await deps.spotter.lookupStatuses(ids);
      await deps.memory.rememberStatuses(statuses);
      return { headlineStatuses: statuses };
    } catch (error) {
      await deps.actionLog.record({ actor, action: "lookup_status", outcome: "failed", threadId: state.date, detail: { error: errorMessage(error) } });
      return { headlineStatuses: [] };
    }
  };

  const fetchSource = async (state: DigestStateType) => {
    const source = deps.sources.require(state.sourceLabel);
    try {
      const items = await source.fetchRecent();
      const unseen = [];
      for (const item of items) {
        if (!(await deps.memory.hasSeen(item))) unseen.push(item);
      }
      await deps.actionLog.record({ actor, action: "fetch_source", outcome: "ok", threadId: state.date, subject: source.label, detail: { fetched: items.length, unseen: unseen.length } });
      return { newsItems: unseen };
    } catch (error) {
      await deps.actionLog.record({ actor, action: "fetch_source", outcome: "failed", threadId: state.date, subject: source.label, detail: { error: errorMessage(error) } });
      return { sourceFailures: [`${source.label}: ${errorMessage(error)}`] };
    }
  };

  const compose = async (state: DigestStateType) => {
    const previousDigests = await deps.memory.recentDigests(PREVIOUS_DIGESTS_SHOWN);
    const task = digestTaskPrompt({
      date: state.date,
      events: state.events,
      headlineStatuses: state.headlineStatuses,
      newsItems: state.newsItems,
      previousDigests,
      revisionFeedback: state.validation?.reasons ?? [],
    });
    const reply = await deps.models.create("compose").invoke([new SystemMessage(buildSystemPrompt(task)), new HumanMessage("Write the cast now.")]);
    const parsed = parseJsonReply(reply, draftSchema);
    const embedUrls = parsed.embedUrl && allowedEmbeds(state).has(parsed.embedUrl) ? [parsed.embedUrl] : [];
    return { draft: { text: parsed.text.trim(), embedUrls }, attempts: state.attempts + 1 };
  };

  const validate = async (state: DigestStateType) => {
    const allowedInvaderIds = new Set(state.events.map((event) => event.displayId));
    const validation = deps.validator.validate({ text: state.draft?.text ?? "", allowedInvaderIds });
    await deps.actionLog.record({ actor, action: "validate_draft", outcome: validation.ok ? "ok" : "failed", threadId: state.date, detail: { attempt: state.attempts, reasons: validation.reasons, text: state.draft?.text } });
    return { validation };
  };

  const attachHeadlineImage = (state: DigestStateType) => {
    if (!state.draft || state.draft.embedUrls.length > 0) return {};
    const mentioned = new Set(extractInvaderIds(state.draft.text).map(formatInvaderId));
    const headline = state.headlineStatuses.find((status) => mentioned.has(status.displayId) && status.closeUpImageUrl);
    if (!headline?.closeUpImageUrl) return {};
    return { draft: { ...state.draft, embedUrls: [headline.closeUpImageUrl] } };
  };

  const publish = async (state: DigestStateType) => {
    if (!state.draft) throw new Error("publish reached without a draft");
    const published = await deps.farcaster.publishCast({ text: state.draft.text, embedUrls: state.draft.embedUrls, channelId: deps.channelId });
    await deps.memory.rememberDigest({ date: state.date, text: state.draft.text, castHash: published.hash });
    await deps.memory.markSeen(state.newsItems);
    return { published };
  };

  const giveUp = async (state: DigestStateType) => {
    const reason = state.validation ? `draft rejected after ${state.attempts} attempts: ${state.validation.reasons.join("; ")}` : "nothing new to report";
    await deps.actionLog.record({ actor, action: "digest_skipped", outcome: "skipped", threadId: state.date, detail: { reason } });
    return { skippedReason: reason };
  };

  const afterCheck = (state: DigestStateType) => (state.skippedReason ? END : "fetchSpotterNews");
  const fanOutSources = (state: DigestStateType) => {
    if (state.sourceLabels.length === 0) return "collect";
    return state.sourceLabels.map((sourceLabel) => new Send("fetchSource", { ...state, sourceLabel }));
  };
  const afterCollect = (state: DigestStateType) => (state.events.length === 0 && state.newsItems.length === 0 ? "giveUp" : "compose");
  const afterValidate = (state: DigestStateType) => {
    if (state.validation?.ok) return "attachHeadlineImage";
    return state.attempts < MAX_COMPOSE_ATTEMPTS ? "compose" : "giveUp";
  };

  return new StateGraph(DigestState)
    .addNode("checkAlreadyPublished", checkAlreadyPublished)
    .addNode("fetchSpotterNews", fetchSpotterNews)
    .addNode("lookupHeadlineStatuses", lookupHeadlineStatuses)
    .addNode("fetchSource", fetchSource)
    .addNode("collect", () => ({}))
    .addNode("compose", compose)
    .addNode("validate", validate)
    .addNode("attachHeadlineImage", attachHeadlineImage)
    .addNode("publish", publish)
    .addNode("giveUp", giveUp)
    .addEdge(START, "checkAlreadyPublished")
    .addConditionalEdges("checkAlreadyPublished", afterCheck, { fetchSpotterNews: "fetchSpotterNews", [END]: END })
    .addEdge("fetchSpotterNews", "lookupHeadlineStatuses")
    .addConditionalEdges("lookupHeadlineStatuses", fanOutSources, ["fetchSource", "collect"])
    .addEdge("fetchSource", "collect")
    .addConditionalEdges("collect", afterCollect, { giveUp: "giveUp", compose: "compose" })
    .addEdge("compose", "validate")
    .addConditionalEdges("validate", afterValidate, { attachHeadlineImage: "attachHeadlineImage", compose: "compose", giveUp: "giveUp" })
    .addEdge("attachHeadlineImage", "publish")
    .addEdge("publish", END)
    .addEdge("giveUp", END)
    .compile({ checkpointer: deps.checkpointer, store: deps.store });
}

export type DigestGraph = ReturnType<typeof buildDigestGraph>;
