import { describe, expect, it, vi } from "vitest";
import { createImageRedirectHandler, type ImageRedirectConfig } from "./imageRedirect.js";

function fakePool(rows: Record<string, unknown>[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

function fakeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    end: vi.fn(),
    set: vi.fn(),
    redirect: vi.fn(),
  };
}

function fakeTokenProvider(token: string | null) {
  return { getToken: vi.fn().mockResolvedValue(token) };
}

const config: ImageRedirectConfig = {
  b2DownloadBase: "https://f000.backblazeb2.com",
  b2Bucket: "flashcastr-images",
};

describe("createImageRedirectHandler", () => {
  it("responds 404 without querying the database for a non-numeric flash_id", async () => {
    const pool = fakePool();
    const tokenProvider = fakeTokenProvider("token");
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "abc" } };
    const res = fakeRes();
    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("responds 404 when no row matches the flash_id", async () => {
    const pool = fakePool([]);
    const tokenProvider = fakeTokenProvider("token");
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "12345" } };
    const res = fakeRes();
    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
  });

  it("responds 404 when the matching row has a null image_tier, even with a non-null ipfs_cid", async () => {
    const pool = fakePool([{ image_tier: null, ipfs_cid: "some-cid" }]);
    const tokenProvider = fakeTokenProvider("token");
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "12345" } };
    const res = fakeRes();
    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
  });

  it("responds 404 when image_tier is set but ipfs_cid is null or empty", async () => {
    const pool = fakePool([{ image_tier: "hd", ipfs_cid: "" }]);
    const tokenProvider = fakeTokenProvider("token");
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "12345" } };
    const res = fakeRes();
    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalled();
  });

  it("redirects with a Cache-Control header to the exact tokened B2 URL when the row and token are valid", async () => {
    const pool = fakePool([{ image_tier: "hd", ipfs_cid: "bafy123" }]);
    const tokenProvider = fakeTokenProvider("mint-token-abc");
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "12345" } };
    const res = fakeRes();
    await handler(req as any, res as any);

    expect(tokenProvider.getToken).toHaveBeenCalledWith("hd");
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "public, max-age=3600");
    expect(res.redirect).toHaveBeenCalledWith(
      "https://f000.backblazeb2.com/file/flashcastr-images/hd/bafy123?Authorization=mint-token-abc",
    );
  });

  it("responds 503 without redirecting when the token provider cannot mint a token", async () => {
    const pool = fakePool([{ image_tier: "hd", ipfs_cid: "bafy123" }]);
    const tokenProvider = fakeTokenProvider(null);
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "12345" } };
    const res = fakeRes();
    await handler(req as any, res as any);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.end).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("caches the row lookup so a second call to the same handler instance does not re-query Postgres", async () => {
    const pool = fakePool([{ image_tier: "hd", ipfs_cid: "bafy123" }]);
    const tokenProvider = fakeTokenProvider("mint-token-abc");
    const handler = createImageRedirectHandler(pool as any, tokenProvider as any, config);

    const req = { params: { flash_id: "12345" } };
    await handler(req as any, fakeRes() as any);
    await handler(req as any, fakeRes() as any);

    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
