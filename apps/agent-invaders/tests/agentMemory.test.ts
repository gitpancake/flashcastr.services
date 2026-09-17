import { InMemoryStore } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { AgentMemory } from "../src/memory/agentMemory.js";

describe("AgentMemory seen items", () => {
  it("accepts source labels containing periods", async () => {
    const memory = new AgentMemory(new InMemoryStore());
    const item = { sourceLabel: "space-invaders.com", url: "https://x/1", title: "t", summary: "", publishedAt: null };
    expect(await memory.hasSeen(item)).toBe(false);
    await memory.markSeen([item]);
    expect(await memory.hasSeen(item)).toBe(true);
  });
});
