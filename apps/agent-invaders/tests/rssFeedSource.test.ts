import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/sources/rssFeedSource.js";

const rss = `<?xml version="1.0"?><rss><channel>
<item><title>New Invader Street Art in London</title><link>https://example.com/a</link><pubDate>Fri, 19 Jun 2026 07:00:00 GMT</pubDate><description><![CDATA[<p>Twelve new <b>mosaics</b></p>]]></description></item>
<item><title>No link here</title></item>
</channel></rss>`;

const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom entry</title><link href="https://example.com/b"/><updated>2026-09-01T00:00:00Z</updated><summary>hi</summary></entry></feed>`;

describe("parseFeed", () => {
  it("parses RSS items with CDATA descriptions", () => {
    expect(parseFeed(rss, "test")).toEqual([
      { sourceLabel: "test", url: "https://example.com/a", title: "New Invader Street Art in London", summary: "Twelve new mosaics", publishedAt: "2026-06-19T07:00:00.000Z" },
    ]);
  });

  it("parses Atom entries", () => {
    expect(parseFeed(atom, "test")[0]).toMatchObject({ url: "https://example.com/b", title: "Atom entry", publishedAt: "2026-09-01T00:00:00.000Z" });
  });
});
