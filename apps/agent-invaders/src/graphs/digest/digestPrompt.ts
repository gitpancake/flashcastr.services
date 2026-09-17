import { cityGlossary, cityNameFor } from "../../invaders/cityCodes.js";
import { describeStatus, type InvaderStatus } from "../../invaders/invaderStatus.js";
import type { InvaderNewsEvent } from "../../invaders/newsPageParser.js";
import type { PublishedDigest } from "../../memory/agentMemory.js";
import type { NewsItem } from "../../sources/newsSource.js";
import { MAX_CAST_CHARS } from "../../validation/lengthValidator.js";

const KIND_HEADINGS: Readonly<Record<InvaderNewsEvent["kind"], string>> = {
  destruction: "Destroyed",
  degradation: "Degraded",
  reactivation: "Reactivated",
  restoration: "Restored",
  addition: "Newly catalogued",
  alert: "Alerts",
  status_update: "Status updates",
};

function eventLines(events: readonly InvaderNewsEvent[]): string {
  const grouped = new Map<InvaderNewsEvent["kind"], InvaderNewsEvent[]>();
  for (const event of events) grouped.set(event.kind, [...(grouped.get(event.kind) ?? []), event]);
  const sections: string[] = [];
  for (const [kind, group] of grouped) {
    const ids = group.map((event) => `${event.displayId} (${cityNameFor(event.cityCode) ?? event.cityCode}, ${event.date})`);
    sections.push(`${KIND_HEADINGS[kind]}: ${ids.join("; ")}`);
  }
  return sections.join("\n");
}

function newsLines(items: readonly NewsItem[]): string {
  return items.map((item) => `- [${item.sourceLabel}] ${item.title} — ${item.url}${item.summary ? `\n  ${item.summary}` : ""}`).join("\n");
}

export interface DigestFacts {
  readonly date: string;
  readonly events: readonly InvaderNewsEvent[];
  readonly headlineStatuses: readonly InvaderStatus[];
  readonly newsItems: readonly NewsItem[];
  readonly previousDigests: readonly PublishedDigest[];
  readonly revisionFeedback: readonly string[];
}

export function digestTaskPrompt(facts: DigestFacts): string {
  const glossary = cityGlossary(facts.events.map((event) => event.cityCode));
  const statuses = facts.headlineStatuses.map(describeStatus).join("\n");
  const previous = facts.previousDigests.map((digest) => `- ${digest.date}: ${digest.text}`).join("\n");
  const feedback = facts.revisionFeedback.length ? `\nEDITOR FEEDBACK ON YOUR LAST ATTEMPT (fix all of it):\n- ${facts.revisionFeedback.join("\n- ")}` : "";
  return `TASK: Broadcast today's (${facts.date}) transmission on the state of the invasion for the /invaders channel.

FACTS FROM invader-spotter.art (last 48h of catalogue changes; these are the ONLY invader IDs you may mention):
${eventLines(facts.events) || "(no catalogue changes)"}

CITY CODES (authoritative — never expand a code any other way):
${glossary || "(none)"}

CURRENT CONDITION OF HEADLINE INVADERS:
${statuses || "(none looked up)"}

FRESH NEWS FROM THE WIDER WEB (unseen until today; mention only if genuinely about the artist Invader or the hunt):
${newsLines(facts.newsItems) || "(nothing new)"}

YOUR RECENT TRANSMISSIONS (do not repeat their content or phrasing):
${previous || "(none)"}
${feedback}

Write ONE transmission under ${MAX_CAST_CHARS - 40} characters. Lead with the most consequential change to the formation. Cite unit IDs exactly as given. Optionally pick ONE embed: a news URL from the list above, or leave embeds empty.

Reply with JSON only: {"text": "<cast>", "embedUrl": "<url or null>"}`;
}
