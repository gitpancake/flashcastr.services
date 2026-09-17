import { FakeListChatModel } from "@langchain/core/utils/testing";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import type { ActionLog, ActionRecord } from "../src/actions/actionLog.js";
import type { CastDraft, FarcasterGateway } from "../src/farcaster/farcasterGateway.js";
import { buildDigestGraph } from "../src/graphs/digest/digestGraph.js";
import type { InvaderNewsEvent } from "../src/invaders/newsPageParser.js";
import { AgentMemory } from "../src/memory/agentMemory.js";
import type { NewsItem, NewsSource } from "../src/sources/newsSource.js";
import { SourceRegistry } from "../src/sources/sourceRegistry.js";
import { createDefaultCastValidator } from "../src/validation/defaultCastValidator.js";

const event: InvaderNewsEvent = { id: { cityCode: "STK", number: 13 }, displayId: "STK_13", cityCode: "STK", districtCode: "STK", kind: "destruction", date: "2026-09-15", sentence: "Destruction de STK_13" };
const article: NewsItem = { sourceLabel: "blog", url: "https://example.com/stockholm", title: "Invader lands in Stockholm", summary: "", publishedAt: "2026-09-15T00:00:00.000Z" };

class StubSource implements NewsSource {
  constructor(readonly label: string, private readonly items: NewsItem[]) {}
  async fetchRecent() { return this.items; }
}

class BrokenSource implements NewsSource {
  readonly label = "broken";
  async fetchRecent(): Promise<NewsItem[]> { throw new Error("boom"); }
}

function harness(modelReplies: string[]) {
  const records: ActionRecord[] = [];
  const actionLog: ActionLog = { record: async (entry) => { records.push(entry); }, countRecent: async () => 0 };
  const published: CastDraft[] = [];
  const farcaster: FarcasterGateway = { publishCast: async (draft) => { published.push(draft); return { hash: "0xcast", fid: 1 }; }, likeCast: async () => undefined };
  const store = new InMemoryStore();
  const memory = new AgentMemory(store, () => new Date("2026-09-16T09:00:00Z"));
  const spotter = { fetchNewsEvents: vi.fn(async () => [event]), lookupStatuses: vi.fn(async () => []) };
  const model = new FakeListChatModel({ responses: modelReplies });
  const models = { create: () => model };
  const graph = buildDigestGraph({
    spotter, memory, models, actionLog, farcaster,
    sources: new SourceRegistry().register(new StubSource("blog", [article])).register(new BrokenSource()),
    validator: createDefaultCastValidator(),
    channelId: "invaders",
    checkpointer: new MemorySaver(),
    store,
  });
  return { graph, records, published, memory };
}

describe("digest graph", () => {
  it("collects sources, composes, validates, publishes and remembers", async () => {
    const { graph, records, published, memory } = harness([JSON.stringify({ text: "STK_13 is gone already. Stockholm giveth, Stockholm taketh 👾", embedUrl: "https://example.com/stockholm" })]);
    const final = await graph.invoke({ date: "2026-09-16" }, { configurable: { thread_id: "digest:test" } });
    expect(final.published).toEqual({ hash: "0xcast", fid: 1 });
    expect(published[0]).toMatchObject({ text: expect.stringContaining("STK_13"), embedUrls: ["https://example.com/stockholm"], channelId: "invaders" });
    expect(final.sourceFailures).toEqual(["broken: boom"]);
    expect(await memory.digestFor("2026-09-16")).toMatchObject({ castHash: "0xcast" });
    expect(await memory.hasSeen(article)).toBe(true);
    expect(records.map((record) => record.action)).toEqual(expect.arrayContaining(["fetch_spotter_news", "fetch_source", "validate_draft"]));
  });

  it("sends an ungrounded draft back for rewrite and publishes the corrected one", async () => {
    const { graph, published } = harness([
      JSON.stringify({ text: "PA_999 destroyed, sad day", embedUrl: null }),
      JSON.stringify({ text: "STK_13 destroyed, sad day", embedUrl: null }),
    ]);
    const final = await graph.invoke({ date: "2026-09-16" }, { configurable: { thread_id: "digest:retry" } });
    expect(final.attempts).toBe(2);
    expect(published).toHaveLength(1);
    expect(published[0]?.text).toContain("STK_13");
  });

  it("skips a date that was already published", async () => {
    const { graph, memory, published } = harness([JSON.stringify({ text: "STK_13 gone", embedUrl: null })]);
    await memory.rememberDigest({ date: "2026-09-16", text: "earlier", castHash: "0xold" });
    const final = await graph.invoke({ date: "2026-09-16" }, { configurable: { thread_id: "digest:dupe" } });
    expect(final.skippedReason).toContain("0xold");
    expect(published).toHaveLength(0);
  });
});
