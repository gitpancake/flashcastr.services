import { describe, expect, it } from "vitest";
import { buildImageUrl, type ImageUrlConfig } from "./image-url.js";

const config: ImageUrlConfig = {
  apiPublicBase: "https://api.example.com",
  origin: "https://api.space-invaders.com",
};

describe("buildImageUrl", () => {
  it("returns the apiPublicBase-based URL when image_tier is set, regardless of img", () => {
    const url = buildImageUrl({ flash_id: 111, image_tier: "feed", img: "/images/1.png" }, config);

    expect(url).toBe("https://api.example.com/i/111");
  });

  it("returns the origin-based URL when image_tier is null and img is set", () => {
    const url = buildImageUrl({ flash_id: 111, image_tier: null, img: "/images/1.png" }, config);

    expect(url).toBe("https://api.space-invaders.com/images/1.png");
  });

  it("returns null when neither image_tier nor img is set", () => {
    const url = buildImageUrl({ flash_id: 111, image_tier: null, img: null }, config);

    expect(url).toBeNull();
  });
});
