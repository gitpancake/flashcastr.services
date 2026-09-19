import { describe, expect, it, vi } from "vitest";
import { loadRecentFlashIds } from "./seed-loader.js";

describe("loadRecentFlashIds", () => {
  it("returns the recent flash ids as a Set", async () => {
    const flashesDb = { getRecentFlashIds: vi.fn().mockResolvedValue([3, 2, 1]) };

    const ids = await loadRecentFlashIds(flashesDb, 10);

    expect(ids).toEqual(new Set([3, 2, 1]));
    expect(flashesDb.getRecentFlashIds).toHaveBeenCalledWith(10);
  });

  it("returns an empty Set when there are no recent flashes", async () => {
    const flashesDb = { getRecentFlashIds: vi.fn().mockResolvedValue([]) };

    const ids = await loadRecentFlashIds(flashesDb, 10000);

    expect(ids).toEqual(new Set());
  });
});
