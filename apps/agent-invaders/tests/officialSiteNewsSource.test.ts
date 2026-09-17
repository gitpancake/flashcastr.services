import { describe, expect, it } from "vitest";
import { parseOfficialNews } from "../src/sources/officialSiteNewsSource.js";

const html = `
<h3 class="lang_en">A collaborative exhibition with artists Damien Hirst and Shepard Fairey.</h3><p>Runs until 29 March 2026.</p>
<h3 class="lang_en">An exhibition from February 17th to May 5th 2024</h3><a href="https://tickets.example">tickets</a>
<h3 class="lang_en">Camouflages &amp; Devils Tower</h3><a href="https://gallery.example/show">Over the Influence</a>`;

describe("parseOfficialNews", () => {
  it("drops announcements that mention a past year", () => {
    const titles = parseOfficialNews(html, 2026).map((item) => item.title);
    expect(titles).toEqual(["A collaborative exhibition with artists Damien Hirst and Shepard Fairey.", "Camouflages & Devils Tower"]);
  });
});
