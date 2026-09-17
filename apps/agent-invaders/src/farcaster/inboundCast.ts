export type InboundKind = "mention" | "reply";

export interface InboundCast {
  readonly hash: string;
  readonly threadHash: string;
  readonly parentHash: string | null;
  readonly authorFid: number;
  readonly authorUsername: string;
  readonly text: string;
  readonly kind: InboundKind;
  readonly receivedAt: string;
}

interface CastLike {
  readonly hash: string;
  readonly thread_hash?: string | null;
  readonly parent_hash?: string | null;
  readonly text: string;
  readonly author: { readonly fid: number; readonly username?: string | null };
}

export function inboundCastFrom(cast: CastLike, receivedAt: string): InboundCast {
  return {
    hash: cast.hash,
    threadHash: cast.thread_hash ?? cast.hash,
    parentHash: cast.parent_hash ?? null,
    authorFid: cast.author.fid,
    authorUsername: cast.author.username ?? `fid:${cast.author.fid}`,
    text: cast.text,
    kind: cast.parent_hash ? "reply" : "mention",
    receivedAt,
  };
}
