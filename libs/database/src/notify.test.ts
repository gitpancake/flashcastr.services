import type { Pool } from "pg";
import type { FlashStoredPayload, FlashCastedPayload } from "@flashcastr/shared-types";
import { describe, expect, it, vi } from "vitest";
import { NOTIFY_CHANNELS, notifyFlashStored, notifyFlashCasted } from "./notify.js";

function buildFlashStoredPayload(overrides: Partial<FlashStoredPayload> = {}): FlashStoredPayload {
  return {
    flash_id: 111,
    img: "https://example.com/img.png",
    city: "Paris",
    text: "flash text",
    player: "player-one",
    timestamp: 1_700_000_000,
    flash_count: "1",
    ipfs_cid: "bafybeitest",
    ipfs_url: "https://ipfs.io/ipfs/bafybeitest",
    db_flash_id: 42,
    stored_at: 1_700_000_005,
    ...overrides,
  };
}

function buildFlashCastedPayload(overrides: Partial<FlashCastedPayload> = {}): FlashCastedPayload {
  return {
    ...buildFlashStoredPayload(),
    cast_hash: "0xabc123",
    user_fid: 4242,
    user_username: "flashuser",
    auto_cast: true,
    ...overrides,
  };
}

function fakeExecutor() {
  return { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;
}

describe("notifyFlashStored", () => {
  it("runs pg_notify on the FLASH_STORED channel with the mapped JSON payload", async () => {
    const executor = fakeExecutor();
    const payload = buildFlashStoredPayload();

    await notifyFlashStored(executor, payload);

    expect(executor.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (executor.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toBe("SELECT pg_notify($1, $2)");
    expect(params[0]).toBe(NOTIFY_CHANNELS.FLASH_STORED);
    expect(JSON.parse(params[1])).toEqual({
      flash_id: "111",
      city: "Paris",
      player: "player-one",
      img: "https://example.com/img.png",
      ipfs_cid: "bafybeitest",
      timestamp: "1700000000",
    });
  });
});

describe("notifyFlashCasted", () => {
  it("runs pg_notify on the FLASH_CASTED channel with the mapped JSON payload, keeping user_fid numeric", async () => {
    const executor = fakeExecutor();
    const payload = buildFlashCastedPayload();

    await notifyFlashCasted(executor, payload);

    expect(executor.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (executor.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toBe("SELECT pg_notify($1, $2)");
    expect(params[0]).toBe(NOTIFY_CHANNELS.FLASH_CASTED);
    const notification = JSON.parse(params[1]);
    expect(notification).toEqual({
      flash_id: "111",
      city: "Paris",
      player: "player-one",
      cast_hash: "0xabc123",
      user_fid: 4242,
      user_username: "flashuser",
    });
    expect(typeof notification.user_fid).toBe("number");
  });

  it("preserves a null cast_hash rather than stringifying it", async () => {
    const executor = fakeExecutor();
    const payload = buildFlashCastedPayload({ cast_hash: null });

    await notifyFlashCasted(executor, payload);

    const [, params] = (executor.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(params[1]).cast_hash).toBeNull();
  });
});
