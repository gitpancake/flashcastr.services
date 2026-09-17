import type { Env } from "../config/env.js";
import { createGoogleNewsSource } from "./googleNewsSource.js";
import type { NewsSource } from "./newsSource.js";
import { OfficialSiteNewsSource } from "./officialSiteNewsSource.js";
import { RssFeedSource } from "./rssFeedSource.js";
import { TavilySearchSource } from "./tavilySearchSource.js";

const BUILT_IN_FEEDS: ReadonlyArray<readonly [string, string]> = [
  ["graffitistreet", "https://graffitistreet.com/tag/invader/feed/"],
];

function extraFeeds(spec: string): RssFeedSource[] {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((url, index) => new RssFeedSource(`rss-${index + 1}`, url));
}

export class SourceRegistry {
  private readonly sources = new Map<string, NewsSource>();

  register(source: NewsSource): this {
    this.sources.set(source.label, source);
    return this;
  }

  labels(): string[] {
    return [...this.sources.keys()];
  }

  require(label: string): NewsSource {
    const source = this.sources.get(label);
    if (!source) throw new Error(`Unknown news source: ${label}`);
    return source;
  }

  static fromEnv(env: Env): SourceRegistry {
    const registry = new SourceRegistry()
      .register(createGoogleNewsSource())
      .register(new OfficialSiteNewsSource());
    for (const [label, url] of BUILT_IN_FEEDS) registry.register(new RssFeedSource(label, url));
    for (const feed of extraFeeds(env.EXTRA_RSS_FEEDS)) registry.register(feed);
    if (env.TAVILY_API_KEY) registry.register(new TavilySearchSource(env.TAVILY_API_KEY));
    return registry;
  }
}
