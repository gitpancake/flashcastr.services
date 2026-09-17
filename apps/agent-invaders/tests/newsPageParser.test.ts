import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNewsPage } from "../src/invaders/newsPageParser.js";

const html = readFileSync(new URL("./fixtures/news-two-months.html", import.meta.url), "utf8");

describe("parseNewsPage", () => {
  const events = parseNewsPage(html);

  it("reads the month section and day into an ISO date", () => {
    const stk13 = events.find((event) => event.displayId === "STK_13");
    expect(stk13).toMatchObject({ date: "2026-09-15", kind: "destruction", cityCode: "STK", districtCode: "STK" });
  });

  it("strips Paris district codes down to the city code", () => {
    const pa845 = events.find((event) => event.displayId === "PA_845");
    expect(pa845).toMatchObject({ cityCode: "PA", districtCode: "PA08", kind: "status_update" });
  });

  it("classifies reactivations and restorations from the sentence verb", () => {
    expect(events.find((event) => event.displayId === "PA_1346")?.kind).toBe("reactivation");
    expect(events.find((event) => event.displayId === "PA_1099")?.kind).toBe("restoration");
    expect(events.find((event) => event.displayId === "PA_296")?.kind).toBe("degradation");
  });

  it("emits one event per invader in a multi-invader sentence", () => {
    const stockholmWave = events.filter((event) => event.kind === "addition" && event.cityCode === "STK" && event.date === "2026-09-11");
    expect(stockholmWave).toHaveLength(16);
    expect(stockholmWave.map((event) => event.displayId)).toContain("STK_19");
  });
});
