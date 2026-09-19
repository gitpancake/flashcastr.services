import type { Flash } from "@flashcastr/shared-types";
import { describe, expect, it, vi } from "vitest";
import { writeFlashBatch } from "./flash-writer.js";

function makeFlash(overrides: Partial<Flash>): Flash {
  return {
    flash_id: 111,
    img: "https://example.com/img.png",
    city: "Paris",
    text: "flash text",
    player: "player-one",
    timestamp: 1_700_000_000,
    flash_count: "1",
    ...overrides,
  };
}

describe("writeFlashBatch", () => {
  it("inserts the batch and enqueues a pin job for every newly-inserted flash_id", async () => {
    const client = {} as never;
    const flashes = [makeFlash({ flash_id: 111 }), makeFlash({ flash_id: 222 })];
    const flashesDb = { insertNew: vi.fn().mockResolvedValue([111, 222]) };
    const flashJobsDb = { enqueue: vi.fn().mockResolvedValue(undefined) };

    const inserted = await writeFlashBatch(client, flashesDb, flashJobsDb, flashes);

    expect(flashesDb.insertNew).toHaveBeenCalledWith(client, flashes);
    expect(flashJobsDb.enqueue).toHaveBeenCalledWith(client, 111, "pin");
    expect(flashJobsDb.enqueue).toHaveBeenCalledWith(client, 222, "pin");
    expect(inserted).toEqual([111, 222]);
  });

  it("enqueues nothing and returns an empty array when insertNew reports no new flashes", async () => {
    const client = {} as never;
    const flashes = [makeFlash({ flash_id: 111 })];
    const flashesDb = { insertNew: vi.fn().mockResolvedValue([]) };
    const flashJobsDb = { enqueue: vi.fn().mockResolvedValue(undefined) };

    const inserted = await writeFlashBatch(client, flashesDb, flashJobsDb, flashes);

    expect(flashJobsDb.enqueue).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("enqueues only the subset insertNew reported as newly inserted, not every input flash", async () => {
    const client = {} as never;
    const flashes = [makeFlash({ flash_id: 111 }), makeFlash({ flash_id: 222 }), makeFlash({ flash_id: 333 })];
    const flashesDb = { insertNew: vi.fn().mockResolvedValue([222]) };
    const flashJobsDb = { enqueue: vi.fn().mockResolvedValue(undefined) };

    const inserted = await writeFlashBatch(client, flashesDb, flashJobsDb, flashes);

    expect(flashJobsDb.enqueue).toHaveBeenCalledTimes(1);
    expect(flashJobsDb.enqueue).toHaveBeenCalledWith(client, 222, "pin");
    expect(inserted).toEqual([222]);
  });
});
