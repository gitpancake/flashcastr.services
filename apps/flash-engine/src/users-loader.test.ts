import { describe, expect, it, vi } from "vitest";
import type { FlashcastrUser } from "@flashcastr/shared-types";
import { loadRegisteredPlayers } from "./users-loader.js";

function activeUser(overrides: Partial<FlashcastrUser>): FlashcastrUser {
  return {
    fid: 1,
    username: "player",
    signer_uuid: "sig",
    auto_cast: true,
    ...overrides,
  };
}

describe("loadRegisteredPlayers", () => {
  it("returns active usernames lowercased as a Set", async () => {
    const usersDb = { getAllActive: vi.fn().mockResolvedValue([activeUser({ username: "SpaceInvader22" }), activeUser({ username: "player2" })]) };

    const players = await loadRegisteredPlayers(usersDb);

    expect(players).toEqual(new Set(["spaceinvader22", "player2"]));
  });

  it("returns an empty Set when there are no active users", async () => {
    const usersDb = { getAllActive: vi.fn().mockResolvedValue([]) };

    const players = await loadRegisteredPlayers(usersDb);

    expect(players).toEqual(new Set());
  });
});
