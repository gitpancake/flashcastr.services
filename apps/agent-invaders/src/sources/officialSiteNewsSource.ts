import { stripTags } from "../invaders/htmlText.js";
import type { NewsItem, NewsSource } from "./newsSource.js";

const NEWS_URL = "https://www.space-invaders.com/news/";
const ENGLISH_HEADLINE = /<h3 class="lang_en">([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3 class="lang_en">|$)/g;
const FIRST_LINK = /<a href="(https?:\/\/[^"]+)"/;
const MAX_ITEMS = 5;

const YEAR = /\b(20\d{2})\b/g;

function mentionsPastYear(text: string, currentYear: number): boolean {
  return [...text.matchAll(YEAR)].some((match) => Number(match[1]) < currentYear);
}

export function parseOfficialNews(html: string, currentYear: number = new Date().getUTCFullYear()): NewsItem[] {
  const items: NewsItem[] = [];
  for (const match of html.matchAll(ENGLISH_HEADLINE)) {
    const [, headline, tail] = match;
    const title = stripTags(headline!);
    if (!title || mentionsPastYear(`${title} ${stripTags(tail!).slice(0, 300)}`, currentYear)) continue;
    const link = FIRST_LINK.exec(tail!)?.[1] ?? NEWS_URL;
    items.push({ sourceLabel: "official-site", url: `${link}#${encodeURIComponent(title)}`, title, summary: title, publishedAt: null });
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

export class OfficialSiteNewsSource implements NewsSource {
  readonly label = "official-site";

  async fetchRecent(): Promise<NewsItem[]> {
    const response = await fetch(NEWS_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; flashcastr-agent/0.1)" } });
    if (!response.ok) throw new Error(`space-invaders.com → ${response.status}`);
    return parseOfficialNews(await response.text());
  }
}
