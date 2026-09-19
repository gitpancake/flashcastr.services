import { NeynarAPIClient } from "@neynar/nodejs-sdk";
import type { PostCastReqBodyEmbeds } from "@neynar/nodejs-sdk/build/api/index.js";
import type { AxiosError } from "axios";
import type { CastGateway, CastUser, PublishedCast, SignerStatus } from "./castGateway.js";

const CAST_CHANNEL_ID = "invaders";

export function buildFlashCast(signerUuid: string, flashId: number, city: string) {
  return {
    signerUuid,
    text: `I just flashed an Invader in ${city}! 👾`,
    embeds: [{ url: `https://www.flashcastr.app/flash/${flashId}` } as PostCastReqBodyEmbeds],
    channelId: CAST_CHANNEL_ID,
  };
}

function formatError(err: unknown): string {
  const axErr = err as AxiosError<{ message?: string; property?: string }>;
  if (axErr.response) {
    const data = axErr.response.data;
    return `${axErr.response.status} ${axErr.response.statusText}: ${data?.message ?? JSON.stringify(data)}`;
  }
  return (err as Error).message;
}

export interface NeynarCastGatewayOptions {
  readonly apiKey: string;
}

export class NeynarCastGateway implements CastGateway {
  private readonly client: NeynarAPIClient;

  constructor(options: NeynarCastGatewayOptions) {
    this.client = new NeynarAPIClient({ apiKey: options.apiKey });
  }

  async fetchUser(fid: number): Promise<CastUser | null> {
    try {
      const response = await this.client.fetchBulkUsers({ fids: [fid] });
      const user = response.users[0];
      if (!user) return null;
      return { pfpUrl: user.pfp_url ?? "", username: user.username };
    } catch (err) {
      throw new Error(formatError(err));
    }
  }

  async publishCast(signerUuid: string, flashId: number, city: string): Promise<PublishedCast> {
    try {
      const cast = await this.client.publishCast(buildFlashCast(signerUuid, flashId, city));
      return { hash: cast.cast.hash };
    } catch (err) {
      throw new Error(formatError(err));
    }
  }

  async lookupSigner(signerUuid: string): Promise<SignerStatus> {
    try {
      const signer = await this.client.lookupSigner({ signerUuid });
      return { status: signer.status };
    } catch (err) {
      throw new Error(formatError(err));
    }
  }
}
