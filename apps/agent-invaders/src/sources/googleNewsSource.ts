import { RssFeedSource } from "./rssFeedSource.js";

const QUERY = '"space invader" mosaic OR "invader" street art OR "flash invaders"';

export function createGoogleNewsSource(): RssFeedSource {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", QUERY);
  url.searchParams.set("hl", "en-GB");
  url.searchParams.set("gl", "GB");
  url.searchParams.set("ceid", "GB:en");
  return new RssFeedSource("google-news", url.toString(), 2);
}
