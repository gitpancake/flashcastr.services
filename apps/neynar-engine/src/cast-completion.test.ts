import { describe, expect, it, vi } from "vitest";
import type { FlashCastedPayload } from "@flashcastr/shared-types";
import { completeCastJob } from "./cast-completion.js";

const CLIENT = {} as never;

function castedPayload(overrides: Partial<FlashCastedPayload> = {}): FlashCastedPayload {
  return {
    flash_id: 1,
    city: "Paris",
    player: "player-one",
    img: "https://example.com/img.png",
    text: "flash text",
    timestamp: 1_700_000_000,
    flash_count: "1",
    ipfs_cid: "bafypinned",
    ipfs_url: "https://gateway.pinata.cloud/ipfs/bafypinned",
    db_flash_id: 1,
    stored_at: 1_700_000_100,
    cast_hash: "0xhash",
    user_fid: 42,
    user_username: "player-one",
    auto_cast: true,
    ...overrides,
  };
}

describe("completeCastJob", () => {
  it("notifies flash_casted when the job completes and a cast was published", async () => {
    const jobsDb = { complete: vi.fn().mockResolvedValue(true) };
    const notify = vi.fn().mockResolvedValue(undefined);
    const payload = castedPayload();

    await completeCastJob(CLIENT, jobsDb, 1, 3, payload, notify);

    expect(jobsDb.complete).toHaveBeenCalledWith(CLIENT, 1, "cast", 3);
    expect(notify).toHaveBeenCalledWith(CLIENT, payload);
  });

  it("skips the notify when the job wasn't published (no user / skipped cast)", async () => {
    const jobsDb = { complete: vi.fn().mockResolvedValue(true) };
    const notify = vi.fn().mockResolvedValue(undefined);

    await completeCastJob(CLIENT, jobsDb, 1, 3, null, notify);

    expect(notify).not.toHaveBeenCalled();
  });

  it("skips the notify when complete() lost the lease fence (job already reclaimed)", async () => {
    const jobsDb = { complete: vi.fn().mockResolvedValue(false) };
    const notify = vi.fn().mockResolvedValue(undefined);
    const payload = castedPayload();

    await completeCastJob(CLIENT, jobsDb, 1, 3, payload, notify);

    expect(notify).not.toHaveBeenCalled();
  });
});
