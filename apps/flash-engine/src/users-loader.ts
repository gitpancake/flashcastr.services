import type { FlashcastrUser } from "@flashcastr/shared-types";

export interface RegisteredPlayersSource {
  getAllActive(): Promise<FlashcastrUser[]>;
}

export async function loadRegisteredPlayers(usersDb: RegisteredPlayersSource): Promise<Set<string>> {
  const users = await usersDb.getAllActive();
  const usernames = users.map((u) => u.username.toLowerCase());
  return new Set(usernames);
}
