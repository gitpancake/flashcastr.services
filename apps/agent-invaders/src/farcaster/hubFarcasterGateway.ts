import {
  CastType,
  FarcasterNetwork,
  Message,
  NobleEd25519Signer,
  ReactionType,
  makeCastAdd,
  makeReactionAdd,
  type CastAddBody,
} from "@farcaster/core";
import type { CastDraft, CastReference, FarcasterGateway, PublishedCast } from "./farcasterGateway.js";

export interface HubGatewayOptions {
  readonly hubHttpUrl: string;
  readonly hubApiKey: string;
  readonly fid: number;
  readonly signerPrivateKeyHex: string;
  readonly defaultChannelId: string;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

function channelParentUrl(channelId: string): string {
  return `https://warpcast.com/~/channel/${channelId}`;
}

export class HubFarcasterGateway implements FarcasterGateway {
  private readonly signer: NobleEd25519Signer;

  constructor(private readonly options: HubGatewayOptions) {
    this.signer = new NobleEd25519Signer(hexToBytes(options.signerPrivateKeyHex));
  }

  async publishCast(draft: CastDraft): Promise<PublishedCast> {
    const body = this.castBody(draft);
    const signed = await makeCastAdd(body, this.dataOptions(), this.signer);
    if (signed.isErr()) throw new Error(`Failed to sign cast: ${signed.error.message}`);
    const hash = await this.submit(Message.encode(signed.value).finish());
    return { hash, fid: this.options.fid };
  }

  async likeCast(target: CastReference): Promise<void> {
    const body = { type: ReactionType.LIKE, targetCastId: { fid: target.fid, hash: hexToBytes(target.hash) } };
    const signed = await makeReactionAdd(body, this.dataOptions(), this.signer);
    if (signed.isErr()) throw new Error(`Failed to sign like: ${signed.error.message}`);
    await this.submit(Message.encode(signed.value).finish());
  }

  async signerPublicKeyHex(): Promise<string> {
    const key = await this.signer.getSignerKey();
    if (key.isErr()) throw new Error(`Cannot derive signer public key: ${key.error.message}`);
    return `0x${Buffer.from(key.value).toString("hex")}`;
  }

  private castBody(draft: CastDraft): CastAddBody {
    const body: CastAddBody = {
      type: CastType.CAST,
      text: draft.text,
      embeds: (draft.embedUrls ?? []).map((url) => ({ url })),
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
    };
    if (draft.replyTo) {
      body.parentCastId = { fid: draft.replyTo.fid, hash: hexToBytes(draft.replyTo.hash) };
      return body;
    }
    body.parentUrl = channelParentUrl(draft.channelId ?? this.options.defaultChannelId);
    return body;
  }

  private dataOptions() {
    return { fid: this.options.fid, network: FarcasterNetwork.MAINNET };
  }

  private async submit(messageBytes: Uint8Array): Promise<string> {
    const response = await fetch(`${this.options.hubHttpUrl}/v1/submitMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-api-key": this.options.hubApiKey },
      body: messageBytes,
    });
    const payload = (await response.json()) as { hash?: string; errCode?: string; message?: string };
    if (!response.ok || !payload.hash) {
      throw new Error(`Hub rejected message: ${payload.errCode ?? response.status}: ${payload.message ?? ""}`);
    }
    return payload.hash;
  }
}
