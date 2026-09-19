import type { FlashcastrUser } from "@flashcastr/shared-types";

export interface RegisteredPlayersSource {
  getAll(): Promise<FlashcastrUser[]>;
}

export async function loadRegisteredPlayers(usersDb: RegisteredPlayersSource): Promise<Set<string>> {
  const users = await usersDb.getAll();
  const usernames = users.map((u) => u.username.toLowerCase());
  return new Set(usernames);
}
