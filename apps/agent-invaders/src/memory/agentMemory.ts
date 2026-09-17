import type { BaseStore } from "@langchain/langgraph";
import type { InvaderStatus } from "../invaders/invaderStatus.js";
import type { NewsItem } from "../sources/newsSource.js";
import { createHash } from "node:crypto";

export interface PublishedDigest {
  readonly date: string;
  readonly text: string;
  readonly castHash: string;
}

export interface LearnedCorrection {
  readonly wrongClaim: string;
  readonly correctFact: string;
  readonly taughtBy: string;
  readonly learnedAt: string;
}

export interface KnownUser {
  readonly fid: number;
  readonly username: string;
  readonly notes: readonly string[];
  readonly lastSeenAt: string;
}

const STATUS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CORRECTIONS = 30;
const MAX_USER_NOTES = 10;

function keyFor(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export class AgentMemory {
  constructor(private readonly store: BaseStore, private readonly clock: () => Date = () => new Date()) {}

  async hasSeen(item: NewsItem): Promise<boolean> {
    const existing = await this.store.get(["seen", item.sourceLabel], keyFor(item.url));
    return existing !== null;
  }

  async markSeen(items: readonly NewsItem[]): Promise<void> {
    const seenAt = this.clock().toISOString();
    for (const item of items) {
      await this.store.put(["seen", item.sourceLabel], keyFor(item.url), { url: item.url, title: item.title, seenAt });
    }
  }

  async cachedStatus(displayId: string): Promise<InvaderStatus | null> {
    const item = await this.store.get(["invader-status"], displayId);
    if (!item) return null;
    const status = item.value as unknown as InvaderStatus;
    const age = this.clock().getTime() - new Date(status.fetchedAt).getTime();
    return age < STATUS_TTL_MS ? status : null;
  }

  async rememberStatuses(statuses: readonly InvaderStatus[]): Promise<void> {
    for (const status of statuses) {
      await this.store.put(["invader-status"], status.displayId, { ...status });
    }
  }

  async recentDigests(limit: number): Promise<PublishedDigest[]> {
    const items = await this.store.search(["digests"], { limit: 50 });
    return items
      .map((item) => item.value as unknown as PublishedDigest)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }

  async digestFor(date: string): Promise<PublishedDigest | null> {
    const item = await this.store.get(["digests"], date);
    return item ? (item.value as unknown as PublishedDigest) : null;
  }

  async rememberDigest(digest: PublishedDigest): Promise<void> {
    await this.store.put(["digests"], digest.date, { ...digest });
  }

  async corrections(): Promise<LearnedCorrection[]> {
    const items = await this.store.search(["corrections"], { limit: MAX_CORRECTIONS });
    return items.map((item) => item.value as unknown as LearnedCorrection).sort((a, b) => a.learnedAt.localeCompare(b.learnedAt));
  }

  async learnCorrection(correction: Omit<LearnedCorrection, "learnedAt">): Promise<void> {
    const learnedAt = this.clock().toISOString();
    await this.store.put(["corrections"], keyFor(correction.wrongClaim.toLowerCase()), { ...correction, learnedAt });
  }

  async knownUser(fid: number): Promise<KnownUser | null> {
    const item = await this.store.get(["users"], String(fid));
    return item ? (item.value as unknown as KnownUser) : null;
  }

  async rememberUser(fid: number, username: string, note?: string): Promise<void> {
    const existing = await this.knownUser(fid);
    const notes = note ? [...(existing?.notes ?? []), note].slice(-MAX_USER_NOTES) : existing?.notes ?? [];
    await this.store.put(["users"], String(fid), { fid, username, notes, lastSeenAt: this.clock().toISOString() });
  }
}
