import { stripTags } from "../invaders/htmlText.js";
import type { NewsItem, NewsSource } from "./newsSource.js";

const ITEM = /<(item|entry)\b[\s\S]*?<\/\1>/g;
const MAX_SUMMARY_CHARS = 400;

function tagContent(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  if (!match) return null;
  return stripTags(match[1]!.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1"));
}

function linkOf(xml: string): string | null {
  const atomHref = /<link\b[^>]*href="([^"]+)"/i.exec(xml);
  if (atomHref) return atomHref[1]!;
  return tagContent(xml, "link");
}

function publishedOf(xml: string): string | null {
  const raw = tagContent(xml, "pubDate") ?? tagContent(xml, "published") ?? tagContent(xml, "updated");
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseFeed(xml: string, sourceLabel: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(ITEM)) {
    const entry = match[0];
    const url = linkOf(entry);
    const title = tagContent(entry, "title");
    if (!url || !title) continue;
    const summary = tagContent(entry, "description") ?? tagContent(entry, "summary") ?? tagContent(entry, "content") ?? "";
    items.push({ sourceLabel, url, title, summary: summary.slice(0, MAX_SUMMARY_CHARS), publishedAt: publishedOf(entry) });
  }
  return items;
}

export class RssFeedSource implements NewsSource {
  constructor(
    readonly label: string,
    private readonly feedUrl: string,
    private readonly maxAgeDays: number = 3,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async fetchRecent(): Promise<NewsItem[]> {
    const response = await fetch(this.feedUrl, { headers: { "User-Agent": "flashcastr-agent/0.1" } });
    if (!response.ok) throw new Error(`${this.label} feed → ${response.status}`);
    const cutoff = this.clock().getTime() - this.maxAgeDays * 24 * 60 * 60 * 1000;
    return parseFeed(await response.text(), this.label).filter((item) => this.isRecent(item, cutoff));
  }

  private isRecent(item: NewsItem, cutoff: number): boolean {
    if (!item.publishedAt) return true;
    return new Date(item.publishedAt).getTime() >= cutoff;
  }
}
