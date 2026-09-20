import { createHash } from "crypto";

export interface PromoteCandidate {
  flash_id: number;
  ipfs_cid: string;
  image_tier: string | null;
}

export interface FetchedImage {
  data: Buffer;
  contentType: string;
}

export interface CopySource {
  fetchFeedBytes(hash: string): Promise<FetchedImage>;
  fetchPinataBytes(cid: string): Promise<FetchedImage>;
}

export interface CopyDestination {
  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

export interface CopyOutcome {
  flashId: number;
  key: string;
  verified: boolean;
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function copyCandidateToKeepTier(
  candidate: PromoteCandidate,
  source: CopySource,
  destination: CopyDestination
): Promise<CopyOutcome> {
  const fetched =
    candidate.image_tier === "feed"
      ? await source.fetchFeedBytes(candidate.ipfs_cid)
      : await source.fetchPinataBytes(candidate.ipfs_cid);

  const readHash = sha256Hex(fetched.data);
  const key = `keep/${candidate.ipfs_cid}`;
  await destination.putObject(key, fetched.data, fetched.contentType);

  const writtenBytes = await destination.getObject(key);
  const writtenHash = sha256Hex(writtenBytes);

  return {
    flashId: candidate.flash_id,
    key,
    verified: readHash === writtenHash,
  };
}
