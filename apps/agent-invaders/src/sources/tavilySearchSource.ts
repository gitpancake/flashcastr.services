import type { NewsItem, NewsSource } from "./newsSource.js";

interface TavilyResult {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly published_date?: string;
}

export class TavilySearchSource implements NewsSource {
  readonly label = "tavily";

  constructor(private readonly apiKey: string, private readonly query = "Space Invader street art mosaic news") {}

  async fetchRecent(): Promise<NewsItem[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query: this.query, topic: "news", days: 2, max_results: 8 }),
    });
    if (!response.ok) throw new Error(`tavily → ${response.status}`);
    const payload = (await response.json()) as { results?: TavilyResult[] };
    return (payload.results ?? []).map((result) => ({
      sourceLabel: this.label,
      url: result.url,
      title: result.title,
      summary: result.content.slice(0, 400),
      publishedAt: result.published_date ?? null,
    }));
  }
}
