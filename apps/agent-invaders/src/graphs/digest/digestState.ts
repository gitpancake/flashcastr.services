import { Annotation } from "@langchain/langgraph";
import type { PublishedCast } from "../../farcaster/farcasterGateway.js";
import type { InvaderStatus } from "../../invaders/invaderStatus.js";
import type { InvaderNewsEvent } from "../../invaders/newsPageParser.js";
import type { NewsItem } from "../../sources/newsSource.js";
import type { ValidationVerdict } from "../../validation/castValidator.js";

export interface DigestDraft {
  readonly text: string;
  readonly embedUrls: readonly string[];
}

const uniqueByUrl = (left: NewsItem[], right: NewsItem[]) => {
  const merged = new Map(left.map((item) => [item.url, item]));
  for (const item of right) merged.set(item.url, item);
  return [...merged.values()];
};

const uniqueStrings = (left: string[], right: string[]) => [...new Set([...left, ...right])];

export const DigestState = Annotation.Root({
  date: Annotation<string>,
  sourceLabels: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  sourceLabel: Annotation<string>,
  events: Annotation<InvaderNewsEvent[]>({ reducer: (_, next) => next, default: () => [] }),
  headlineStatuses: Annotation<InvaderStatus[]>({ reducer: (_, next) => next, default: () => [] }),
  newsItems: Annotation<NewsItem[]>({ reducer: uniqueByUrl, default: () => [] }),
  sourceFailures: Annotation<string[]>({ reducer: uniqueStrings, default: () => [] }),
  draft: Annotation<DigestDraft | null>({ reducer: (_, next) => next, default: () => null }),
  validation: Annotation<ValidationVerdict | null>({ reducer: (_, next) => next, default: () => null }),
  attempts: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  published: Annotation<PublishedCast | null>({ reducer: (_, next) => next, default: () => null }),
  skippedReason: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
});

export type DigestStateType = typeof DigestState.State;
