import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import type { ActionLog, ActionRecord } from "./actions/actionLog.js";
import type { CastDraft, CastReference, FarcasterGateway } from "./farcaster/farcasterGateway.js";
import { buildConversationGraph } from "./graphs/conversation/conversationGraph.js";
import { createConversationTools } from "./graphs/conversation/conversationTools.js";
import { buildDigestGraph } from "./graphs/digest/digestGraph.js";
import type { FarcasterReader } from "./farcaster/neynarReader.js";
import { InvaderSpotterClient } from "./invaders/invaderSpotterClient.js";
import { InvaderSpotterSession } from "./invaders/invaderSpotterSession.js";
import { FireworksModelFactory } from "./llm/languageModelFactory.js";
import { AgentMemory } from "./memory/agentMemory.js";
import { SourceRegistry } from "./sources/sourceRegistry.js";
import { createDefaultCastValidator } from "./validation/defaultCastValidator.js";

const previewEnvSchema = z.object({
  FIREWORKS_API_KEY: z.string().min(1),
  FIREWORKS_MODEL: z.string().default("accounts/fireworks/models/glm-5p3"),
  FIREWORKS_BASE_URL: z.string().url().default("https://api.fireworks.ai/inference/v1"),
  EXTRA_RSS_FEEDS: z.string().default(""),
  TAVILY_API_KEY: z.string().optional(),
});

class PrintingGateway implements FarcasterGateway {
  async publishCast(draft: CastDraft) {
    console.log(`\n--- would publish (${draft.text.length} chars) ---\n${draft.text}\nembeds: ${JSON.stringify(draft.embedUrls ?? [])}\n`);
    return { hash: "0xpreview", fid: 0 };
  }
  async likeCast(_target: CastReference) {}
}

class PrintingActionLog implements ActionLog {
  async record(entry: ActionRecord) {
    const detail = entry.action === "validate_draft" ? JSON.stringify(entry.detail?.reasons ?? []) : "";
    console.log(`[${entry.outcome}] ${entry.action} ${entry.subject ?? ""} ${detail}`);
  }
  async countRecent() {
    return 0;
  }
}

export async function previewDigest(date: string): Promise<void> {
  const env = previewEnvSchema.parse(process.env);
  const graph = buildDigestGraph({
    spotter: new InvaderSpotterClient(new InvaderSpotterSession()),
    sources: SourceRegistry.fromEnv({ ...env, TAVILY_API_KEY: env.TAVILY_API_KEY } as never),
    memory: new AgentMemory(new InMemoryStore()),
    models: new FireworksModelFactory(env),
    validator: createDefaultCastValidator(),
    farcaster: new PrintingGateway(),
    actionLog: new PrintingActionLog(),
    channelId: "invaders",
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  });
  const final = await graph.invoke({ date }, { configurable: { thread_id: `preview:${date}:${Date.now()}` } });
  if (final.skippedReason) console.log(`skipped: ${final.skippedReason}`);
}

export async function previewReply(text: string): Promise<void> {
  const env = previewEnvSchema.parse(process.env);
  const store = new InMemoryStore();
  const memory = new AgentMemory(store);
  const spotter = new InvaderSpotterClient(new InvaderSpotterSession());
  const reader: FarcasterReader = { fetchRecentInbound: async () => [], fetchThreadContext: async () => [] };
  const graph = buildConversationGraph({
    reader,
    memory,
    models: new FireworksModelFactory(env),
    tools: createConversationTools({ spotter, memory }),
    validator: createDefaultCastValidator(),
    farcaster: new PrintingGateway(),
    actionLog: new PrintingActionLog(),
    checkpointer: new MemorySaver(),
    store,
  });
  const now = new Date().toISOString();
  const inbound = { hash: "0xpreview", threadHash: "0xpreview", parentHash: null, authorFid: 732, authorUsername: "henry", text, kind: "mention" as const, castAt: now, receivedAt: now };
  await graph.invoke({ inbound }, { configurable: { thread_id: `preview-reply:${Date.now()}` } });
}
