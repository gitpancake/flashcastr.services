import { createLogger } from "@flashcastr/logger";

const log = createLogger("api");

const B2_API_BASE = "https://api.backblazeb2.com";

export interface B2TokenProviderOptions {
  keyId: string;
  applicationKey: string;
  bucketId: string;
  validDurationSeconds?: number;
  remintAfterMs?: number;
}

export interface B2TokenProvider {
  getToken(prefix: string): Promise<string | null>;
}

interface CacheEntry {
  token: string;
  mintedAt: number;
  validUntil: number;
}

interface AuthorizeAccountResponse {
  authorizationToken: string;
  apiInfo: { storageApi: { apiUrl: string } };
}

interface GetDownloadAuthorizationResponse {
  authorizationToken: string;
}

async function mintDownloadToken(options: Required<B2TokenProviderOptions>, prefix: string): Promise<string> {
  const authorizeResponse = await fetch(`${B2_API_BASE}/b2api/v4/b2_authorize_account`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${options.keyId}:${options.applicationKey}`).toString("base64")}`,
    },
  });
  if (!authorizeResponse.ok) throw new Error(`b2_authorize_account failed: ${authorizeResponse.status}`);
  const authorizeBody = (await authorizeResponse.json()) as AuthorizeAccountResponse;

  const mintResponse = await fetch(
    `${authorizeBody.apiInfo.storageApi.apiUrl}/b2api/v4/b2_get_download_authorization`,
    {
      method: "POST",
      headers: { Authorization: authorizeBody.authorizationToken },
      body: JSON.stringify({
        bucketId: options.bucketId,
        fileNamePrefix: `${prefix}/`,
        validDurationInSeconds: options.validDurationSeconds,
      }),
    },
  );
  if (!mintResponse.ok) throw new Error(`b2_get_download_authorization failed: ${mintResponse.status}`);
  const mintBody = (await mintResponse.json()) as GetDownloadAuthorizationResponse;
  return mintBody.authorizationToken;
}

export function createB2TokenProvider(options: B2TokenProviderOptions, now: () => number = Date.now): B2TokenProvider {
  const resolved: Required<B2TokenProviderOptions> = {
    validDurationSeconds: 604800,
    remintAfterMs: 86400000,
    ...options,
  };
  const entries = new Map<string, CacheEntry>();

  return {
    async getToken(prefix: string): Promise<string | null> {
      const cached = entries.get(prefix);
      if (cached && now() - cached.mintedAt < resolved.remintAfterMs) return cached.token;

      try {
        const token = await mintDownloadToken(resolved, prefix);
        entries.set(prefix, { token, mintedAt: now(), validUntil: now() + resolved.validDurationSeconds * 1000 });
        return token;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (cached && cached.validUntil > now()) {
          log.warn(`B2 download token remint failed for ${prefix}/, serving cached token: ${reason}`);
          return cached.token;
        }
        log.error(`B2 download token mint failed for ${prefix}/: ${reason}`);
        return null;
      }
    },
  };
}
