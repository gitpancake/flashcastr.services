import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cityNameFor } from "../../invaders/cityCodes.js";
import { formatInvaderId, parseInvaderId, type InvaderId } from "../../invaders/invaderId.js";
import type { InvaderNewsFeed, InvaderStatusLookup } from "../../invaders/invaderSpotterClient.js";
import { describeStatus, type InvaderStatus } from "../../invaders/invaderStatus.js";
import type { InvaderNewsEvent } from "../../invaders/newsPageParser.js";
import type { AgentMemory } from "../../memory/agentMemory.js";
import { RssFeedSource } from "../../sources/rssFeedSource.js";

export interface ConversationToolDependencies {
  readonly spotter: InvaderNewsFeed & InvaderStatusLookup;
  readonly memory: AgentMemory;
  readonly clock?: () => Date;
}

const NEWS_CACHE_MS = 30 * 60 * 1000;
const MAX_IDS_PER_LOOKUP = 8;
const MAX_EVENTS_RETURNED = 15;

class CachedNewsEvents {
  private events: InvaderNewsEvent[] = [];
  private fetchedAt = 0;

  constructor(private readonly feed: InvaderNewsFeed, private readonly clock: () => Date) {}

  async current(): Promise<InvaderNewsEvent[]> {
    const now = this.clock().getTime();
    if (now - this.fetchedAt < NEWS_CACHE_MS) return this.events;
    this.events = await this.feed.fetchNewsEvents();
    this.fetchedAt = now;
    return this.events;
  }
}

async function resolveStatuses(deps: ConversationToolDependencies, ids: readonly InvaderId[]): Promise<InvaderStatus[]> {
  const fresh: InvaderStatus[] = [];
  const missing: InvaderId[] = [];
  for (const id of ids) {
    const cached = await deps.memory.cachedStatus(formatInvaderId(id));
    if (cached) fresh.push(cached);
    else missing.push(id);
  }
  if (missing.length === 0) return fresh;
  const looked = await deps.spotter.lookupStatuses(missing);
  await deps.memory.rememberStatuses(looked);
  return [...fresh, ...looked];
}

export function createConversationTools(deps: ConversationToolDependencies) {
  const clock = deps.clock ?? (() => new Date());
  const newsCache = new CachedNewsEvents(deps.spotter, clock);

  const lookupInvaderStatus = tool(
    async ({ invaderIds }) => {
      const parsed = invaderIds.map(parseInvaderId).filter((id): id is InvaderId => id !== null).slice(0, MAX_IDS_PER_LOOKUP);
      if (parsed.length === 0) return "No valid invader IDs given. IDs look like PA_04 or LDN_123.";
      const statuses = await resolveStatuses(deps, parsed);
      const found = new Set(statuses.map((status) => status.displayId));
      const notFound = parsed.map(formatInvaderId).filter((displayId) => !found.has(displayId));
      const lines = statuses.map(describeStatus);
      if (notFound.length) lines.push(`Not in the invader-spotter catalogue: ${notFound.join(", ")}.`);
      return lines.join("\n");
    },
    {
      name: "lookup_invader_status",
      description: "Look up the current catalogued condition (OK / degraded / destroyed / not visible), points, city, install date and latest spotter reports for specific invader IDs like PA_04, LDN_123, NY_12.",
      schema: z.object({ invaderIds: z.array(z.string()).min(1).max(MAX_IDS_PER_LOOKUP) }),
    },
  );

  const recentInvaderEvents = tool(
    async ({ cityCode, invaderId, days }) => {
      const cutoff = clock();
      cutoff.setUTCDate(cutoff.getUTCDate() - days);
      const wantedId = invaderId ? parseInvaderId(invaderId) : null;
      const events = (await newsCache.current())
        .filter((event) => new Date(event.date).getTime() >= cutoff.getTime())
        .filter((event) => (cityCode ? event.cityCode === cityCode.toUpperCase() : true))
        .filter((event) => (wantedId ? event.displayId === formatInvaderId(wantedId) : true))
        .slice(0, MAX_EVENTS_RETURNED);
      if (events.length === 0) return `No catalogue changes in the last ${days} days for that filter.`;
      return events.map((event) => `${event.date} ${event.kind} ${event.displayId} (${cityNameFor(event.cityCode) ?? event.cityCode})`).join("\n");
    },
    {
      name: "recent_invader_events",
      description: "List recent catalogue changes (destructions, degradations, reactivations, restorations, additions) from invader-spotter.art, optionally filtered by city code (e.g. PA, LDN) or a single invader ID.",
      schema: z.object({
        cityCode: z.string().optional(),
        invaderId: z.string().optional(),
        days: z.number().int().min(1).max(90).default(14),
      }),
    },
  );

  const searchInvaderNews = tool(
    async ({ query }) => {
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", `${query} invader`);
      url.searchParams.set("hl", "en-GB");
      url.searchParams.set("gl", "GB");
      url.searchParams.set("ceid", "GB:en");
      const items = await new RssFeedSource("google-news", url.toString(), 60, clock).fetchRecent();
      if (items.length === 0) return "No recent news found for that query.";
      return items.slice(0, 6).map((item) => `- ${item.title} (${item.publishedAt?.slice(0, 10) ?? "undated"}) ${item.url}`).join("\n");
    },
    {
      name: "search_invader_news",
      description: "Search recent web news about the street artist Invader, exhibitions, auctions or city invasions.",
      schema: z.object({ query: z.string().min(2) }),
    },
  );

  const rememberCorrection = tool(
    async ({ wrongClaim, correctFact, taughtBy }) => {
      await deps.memory.learnCorrection({ wrongClaim, correctFact, taughtBy });
      return "Correction stored.";
    },
    {
      name: "remember_correction",
      description: "Store a factual correction the community gave you so you never repeat the wrong claim. Use only when someone credibly corrects a specific fact.",
      schema: z.object({ wrongClaim: z.string().min(3), correctFact: z.string().min(3), taughtBy: z.string() }),
    },
  );

  const noteAboutUser = tool(
    async ({ fid, username, note }) => {
      await deps.memory.rememberUser(fid, username, note);
      return "Noted.";
    },
    {
      name: "note_about_user",
      description: "Remember something durable about the person you are talking to (their home city, favourite invaders, how they like to be answered).",
      schema: z.object({ fid: z.number().int(), username: z.string(), note: z.string().min(3).max(200) }),
    },
  );

  return [lookupInvaderStatus, recentInvaderEvents, searchInvaderNews, rememberCorrection, noteAboutUser];
}

export type ConversationTools = ReturnType<typeof createConversationTools>;
