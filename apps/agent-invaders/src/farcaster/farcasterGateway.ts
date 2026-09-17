export interface CastReference {
  readonly fid: number;
  readonly hash: string;
}

export interface CastDraft {
  readonly text: string;
  readonly embedUrls?: readonly string[];
  readonly channelId?: string;
  readonly replyTo?: CastReference;
}

export interface PublishedCast {
  readonly hash: string;
  readonly fid: number;
}

export interface FarcasterGateway {
  publishCast(draft: CastDraft): Promise<PublishedCast>;
  likeCast(target: CastReference): Promise<void>;
}
