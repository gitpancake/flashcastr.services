export interface CastUser {
  readonly pfpUrl: string;
  readonly username: string;
}

export interface PublishedCast {
  readonly hash: string;
}

export interface SignerStatus {
  readonly status: string;
}

export interface CastGateway {
  fetchUser(fid: number): Promise<CastUser | null>;
  publishCast(signerUuid: string, flashId: number, city: string): Promise<PublishedCast>;
  lookupSigner(signerUuid: string): Promise<SignerStatus>;
}

export function buildCastIdemKey(flashId: number): string {
  return `flash-${flashId}`;
}
