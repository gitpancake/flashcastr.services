import { describe, expect, it } from "vitest";
import { extractInvaderIds, formatInvaderId, parseInvaderId } from "../src/invaders/invaderId.js";

describe("invader ids", () => {
  it("parses loose spellings", () => {
    expect(parseInvaderId("pa_04")).toEqual({ cityCode: "PA", number: 4 });
    expect(parseInvaderId("PA-4")).toEqual({ cityCode: "PA", number: 4 });
    expect(parseInvaderId("LDN 123")).toEqual({ cityCode: "LDN", number: 123 });
    expect(parseInvaderId("hello")).toBeNull();
  });

  it("formats with a two digit minimum", () => {
    expect(formatInvaderId({ cityCode: "PA", number: 4 })).toBe("PA_04");
    expect(formatInvaderId({ cityCode: "PA", number: 1517 })).toBe("PA_1517");
  });

  it("extracts unique ids from prose", () => {
    const ids = extractInvaderIds("how's PA_04 doing? and pa_04 again, plus NY_173").map(formatInvaderId);
    expect(ids).toEqual(["PA_04", "NY_173"]);
  });
});
