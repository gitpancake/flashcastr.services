import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseListingPage } from "../src/invaders/listingPageParser.js";

const html = readFileSync(new URL("./fixtures/listing-pa04-pa12.html", import.meta.url), "utf8");

describe("parseListingPage", () => {
  const statuses = parseListingPage(html, "2026-09-16T00:00:00.000Z");

  it("finds every result block", () => {
    expect(statuses.map((status) => status.displayId)).toEqual(["PA_04", "PA_12"]);
  });

  it("extracts condition, points, district and dates for PA_04", () => {
    const pa04 = statuses[0]!;
    expect(pa04).toMatchObject({
      cityCode: "PA",
      cityName: "Paris",
      district: "Paris - 5ème arrondissement",
      points: 10,
      installedOn: "15/03/1998",
      condition: "degraded",
      conditionLabel: "degraded",
      conditionReportedAt: "mai 2022",
      closeUpImageUrl: "https://www.invader-spotter.art/grosplan/PA/PA_0004-grosplan.png",
    });
    expect(pa04.photoUrls).toHaveLength(2);
  });

  it("keeps the latest spotter comments with decoded accents", () => {
    const pa04 = statuses[0]!;
    expect(pa04.recentComments.length).toBeLessThanOrEqual(3);
    expect(pa04.recentComments.at(-1)?.text).toContain("Flashé le 07/07/2026");
  });

  it("maps OK conditions", () => {
    expect(statuses[1]).toMatchObject({ displayId: "PA_12", condition: "ok", conditionLabel: "OK" });
  });
});
