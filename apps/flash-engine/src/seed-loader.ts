export interface RecentFlashIdsSource {
  getRecentFlashIds(limit: number): Promise<number[]>;
}

export async function loadRecentFlashIds(flashesDb: RecentFlashIdsSource, limit: number): Promise<Set<number>> {
  const ids = await flashesDb.getRecentFlashIds(limit);
  return new Set(ids);
}
