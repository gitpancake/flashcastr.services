import { describe, expect, it } from "vitest";
import { formatSummary, selectPending } from "./promote-keep-set.js";

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
