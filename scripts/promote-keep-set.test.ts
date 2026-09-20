import { describe, expect, it, vi } from "vitest";
import { formatSummary, processCandidate, runWithConcurrency, selectPending } from "./promote-keep-set.js";
import type { CopyDestination, CopySource } from "./lib/promote-copy.js";

const candidate = { flash_id: 42, ipfs_cid: "hash-42", image_tier: "feed" as const };

function fakeSource(bytes: Buffer): CopySource {
  return {
    fetchFeedBytes: vi.fn().mockResolvedValue({ data: bytes, contentType: "image/jpeg" }),
    fetchPinataBytes: vi.fn().mockResolvedValue({ data: bytes, contentType: "image/jpeg" }),
  };
}

function fakeDestination(returnedBytes: Buffer): CopyDestination {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    getObject: vi.fn().mockResolvedValue(returnedBytes),
  };
}

describe("selectPending", () => {
  it("excludes rows already at image_tier 'keep'", () => {
    const candidates = [
      { flash_id: 1, ipfs_cid: "a", image_tier: "keep" },
      { flash_id: 2, ipfs_cid: "b", image_tier: "feed" },
      { flash_id: 3, ipfs_cid: "c", image_tier: null },
    ];

    expect(selectPending(candidates)).toEqual([
      { flash_id: 2, ipfs_cid: "b", image_tier: "feed" },
      { flash_id: 3, ipfs_cid: "c", image_tier: null },
    ]);
  });
});

describe("formatSummary", () => {
  it("reports the counts and lists each failure with its flash_id and reason", () => {
    const output = formatSummary({
      total: 2567,
      alreadyKept: 2560,
      promoted: 5,
      failures: [
        { flashId: 42, reason: "sha256 mismatch after write" },
        { flashId: 99, reason: "404 from Pinata gateway" },
      ],
    });

    expect(output).toContain("2567 total, 2560 already kept, 5 promoted, 2 failed");
    expect(output).toContain("FAILED flash_id=42: sha256 mismatch after write");
    expect(output).toContain("FAILED flash_id=99: 404 from Pinata gateway");
  });

  it("omits the failure list entirely when nothing failed", () => {
    const output = formatSummary({ total: 2567, alreadyKept: 2567, promoted: 0, failures: [] });

    expect(output).toBe("Keep set: 2567 total, 2567 already kept, 0 promoted, 0 failed");
  });
});

describe("processCandidate", () => {
  it("flips the tier and reports promoted when the copy verifies", async () => {
    const bytes = Buffer.from("image-bytes");
    const setTier = vi.fn().mockResolvedValue(undefined);

    const result = await processCandidate(candidate, fakeSource(bytes), fakeDestination(bytes), setTier);

    expect(result).toEqual({ promoted: true });
    expect(setTier).toHaveBeenCalledWith(42, "keep");
  });

  it("does not flip the tier and reports a failure when the write doesn't verify", async () => {
    const setTier = vi.fn().mockResolvedValue(undefined);
    const source = fakeSource(Buffer.from("original"));
    const destination = fakeDestination(Buffer.from("corrupted"));

    const result = await processCandidate(candidate, source, destination, setTier);

    expect(result).toEqual({
      promoted: false,
      failure: { flashId: 42, reason: "sha256 mismatch after write" },
    });
    expect(setTier).not.toHaveBeenCalled();
  });

  it("catches a fetch error, reports it as a failure, and never throws", async () => {
    const setTier = vi.fn().mockResolvedValue(undefined);
    const source: CopySource = {
      fetchFeedBytes: vi.fn().mockRejectedValue(new Error("404 from B2")),
      fetchPinataBytes: vi.fn(),
    };

    const result = await processCandidate(candidate, source, fakeDestination(Buffer.from("x")), setTier);

    expect(result).toEqual({ promoted: false, failure: { flashId: 42, reason: "404 from B2" } });
    expect(setTier).not.toHaveBeenCalled();
  });
});

describe("runWithConcurrency", () => {
  it("runs every item through the worker and returns results in input order", async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);

    expect(results).toEqual([10, 20, 30, 40]);
  });

  it("never runs more than `limit` workers at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return n;
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
