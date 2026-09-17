import { describe, expect, it, vi } from "vitest";
import type { InboundCast } from "../src/farcaster/inboundCast.js";
import type { FarcasterReader } from "../src/farcaster/neynarReader.js";
import type { InboundDispatcher } from "../src/inbound/inboundDispatcher.js";
import { MentionPoller } from "../src/inbound/mentionPoller.js";

function cast(hash: string, castAt: string): InboundCast {
  return { hash, threadHash: hash, parentHash: null, authorFid: 1, authorUsername: "a", text: "hi", kind: "mention", castAt, receivedAt: castAt };
}

describe("MentionPoller", () => {
  it("ignores notifications older than two poll intervals at boot", async () => {
    const now = new Date("2026-09-17T04:00:00Z");
    const reader: FarcasterReader = {
      fetchRecentInbound: async () => [cast("old", "2026-09-17T02:00:00Z"), cast("fresh", "2026-09-17T03:55:00Z")],
      fetchThreadContext: async () => [],
    };
    const dispatch = vi.fn();
    const poller = new MentionPoller(reader, { dispatch } as unknown as InboundDispatcher, 1, 5 * 60 * 1000, { warn: vi.fn() } as never, () => now);
    await poller.pollOnce();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ hash: "fresh" }));
  });
});
