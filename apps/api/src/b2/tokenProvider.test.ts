import { afterEach, describe, expect, it, vi } from "vitest";
import { createB2TokenProvider } from "./tokenProvider.js";

const OPTIONS = {
  keyId: "key-id",
  applicationKey: "app-key",
  bucketId: "bucket-123",
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createB2TokenProvider", () => {
  it("mints a token on the first call via the two-call B2 sequence", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider(OPTIONS, () => clock.t);

    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [authorizeUrl, authorizeInit] = fetchMock.mock.calls[0];
    expect(authorizeUrl).toBe("https://api.backblazeb2.com/b2api/v4/b2_authorize_account");
    expect(authorizeInit.method).toBe("GET");
    expect(authorizeInit.headers.Authorization).toMatch(/^Basic /);

    const [mintUrl, mintInit] = fetchMock.mock.calls[1];
    expect(mintUrl).toBe("https://api-storage.example.com/b2api/v4/b2_get_download_authorization");
    expect(mintInit.method).toBe("POST");
    expect(mintInit.headers.Authorization).toBe("auth-token-1");
    expect(JSON.parse(mintInit.body)).toEqual({
      bucketId: "bucket-123",
      fileNamePrefix: "feed/",
      validDurationInSeconds: 604800,
    });
  });

  it("reuses the cached token within remintAfterMs without calling fetch again", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider({ ...OPTIONS, remintAfterMs: 1000 }, () => clock.t);

    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
    clock.t = 999;
    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("mints a fresh token once remintAfterMs has elapsed", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-1" }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-2",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-2" }));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider({ ...OPTIONS, remintAfterMs: 1000 }, () => clock.t);

    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
    clock.t = 1000;
    await expect(provider.getToken("feed")).resolves.toBe("download-token-2");

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to the stale cached token when a remint fails but the old validity window has not elapsed", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-1" }));
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider(
      { ...OPTIONS, remintAfterMs: 1000, validDurationSeconds: 5000 },
      () => clock.t,
    );

    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
    clock.t = 1000;
    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
  });

  it("falls back to the stale cached token when a remint resolves ok:false", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-1" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider(
      { ...OPTIONS, remintAfterMs: 1000, validDurationSeconds: 5000 },
      () => clock.t,
    );

    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
    clock.t = 1000;
    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
  });

  it("resolves null when a remint fails and the cached token's validity window has elapsed", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "download-token-1" }));
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider(
      { ...OPTIONS, remintAfterMs: 1000, validDurationSeconds: 1 },
      () => clock.t,
    );

    await expect(provider.getToken("feed")).resolves.toBe("download-token-1");
    clock.t = 2000;
    await expect(provider.getToken("feed")).resolves.toBeNull();
  });

  it("resolves null when a remint fails and there was never a cached token", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider(OPTIONS, () => clock.t);

    await expect(provider.getToken("feed")).resolves.toBeNull();
  });

  it("mints and caches feed and keep independently", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-1",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "feed-token" }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        authorizationToken: "auth-token-2",
        apiInfo: { storageApi: { apiUrl: "https://api-storage.example.com" } },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ authorizationToken: "keep-token" }));
    vi.stubGlobal("fetch", fetchMock);

    const clock = { t: 0 };
    const provider = createB2TokenProvider(OPTIONS, () => clock.t);

    await expect(provider.getToken("feed")).resolves.toBe("feed-token");
    await expect(provider.getToken("keep")).resolves.toBe("keep-token");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const keepMintInit = fetchMock.mock.calls[3][1];
    expect(JSON.parse(keepMintInit.body).fileNamePrefix).toBe("keep/");
  });
});
