/**
 * Promotes the keep set out of Pinata / the feed/ tier into the permanent
 * keep/ tier in B2, verifying per-object SHA-256 integrity before flipping
 * image_tier. Idempotent and resumable: a row already at image_tier='keep'
 * is skipped, so re-running after a crash or on a weekly schedule only
 * copies what's still pending. See ticket
 * platform/backblaze-image-storage/03-promote-keep-set.md.
 *
 * Usage:
 *   npm run promote-keep-set -- --dry-run   # print the keep-set count and a sample, write nothing
 *   npm run promote-keep-set                # copy every pending row into keep/
 *
 * Requires DATABASE_URL, B2_S3_ENDPOINT, B2_REGION, B2_BUCKET,
 * B2_PROMOTE_KEY_ID, B2_PROMOTE_KEY (the promote key pair only — never the
 * image-engine key, which is confined to the feed/ prefix and cannot write
 * keep/). Optional: PINATA_GATEWAY (legacy-row fetches; defaults to Henry's
 * dedicated gateway, ~10x faster than the public gateway.pinata.cloud),
 * PROMOTE_CONCURRENCY (default 8), PROMOTE_RATE_LIMIT (requests/min against
 * the gateway + B2, default 600).
 */
import { config } from "dotenv";
config();

import axios from "axios";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getPool, closePool, PostgresFlashesDb, type KeepSetCandidate } from "@flashcastr/database";
import { requireEnv, intEnv, optionalEnv } from "@flashcastr/config";
import { closeLoggers, createLogger } from "@flashcastr/logger";
import { copyCandidateToKeepTier, type CopyDestination, type CopySource } from "./lib/promote-copy.js";

const log = createLogger("promote-keep-set");

// The public gateway.pinata.cloud is ~10x slower than Henry's dedicated
// gateway (same Pinata account) — measured 4.6-6.7s vs 0.4-0.9s per object.
// Overridable via PINATA_GATEWAY since it's the same knob the frontend uses
// (invaders/flashcastr src/lib/constants.ts).
const DEFAULT_PINATA_GATEWAY = "https://fuchsia-rich-lungfish-648.mypinata.cloud/ipfs";

export function selectPending(candidates: KeepSetCandidate[]): KeepSetCandidate[] {
  return candidates.filter((candidate) => candidate.image_tier !== "keep");
}

export interface PromoteFailure {
  flashId: number;
  reason: string;
}

export interface PromoteSummary {
  total: number;
  alreadyKept: number;
  promoted: number;
  failures: PromoteFailure[];
}

export function formatSummary(summary: PromoteSummary): string {
  const lines = [
    `Keep set: ${summary.total} total, ${summary.alreadyKept} already kept, ` +
      `${summary.promoted} promoted, ${summary.failures.length} failed`,
  ];
  for (const failure of summary.failures) {
    lines.push(`  FAILED flash_id=${failure.flashId}: ${failure.reason}`);
  }
  return lines.join("\n");
}

class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly perMinute: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60000);
    if (this.timestamps.length >= this.perMinute) {
      const waitMs = 60000 - (now - this.timestamps[0]);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

interface S3ResponseBody {
  transformToByteArray(): Promise<Uint8Array>;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  return Buffer.from(await (body as S3ResponseBody).transformToByteArray());
}

function buildSource(client: S3Client, bucket: string, rateLimiter: RateLimiter, gatewayUrl: string): CopySource {
  return {
    async fetchFeedBytes(hash) {
      await rateLimiter.wait();
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `feed/${hash}` }));
      return { data: await bodyToBuffer(res.Body), contentType: res.ContentType ?? "image/jpeg" };
    },
    async fetchPinataBytes(cid) {
      await rateLimiter.wait();
      const res = await axios.get<ArrayBuffer>(`${gatewayUrl}/${cid}`, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      return { data: Buffer.from(res.data), contentType: String(res.headers["content-type"] ?? "image/jpeg") };
    },
  };
}

function buildDestination(client: S3Client, bucket: string): CopyDestination {
  return {
    async putObject(key, data, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: contentType }));
    },
    async getObject(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return bodyToBuffer(res.Body);
    },
  };
}

export interface ProcessResult {
  promoted: boolean;
  failure?: PromoteFailure;
}

/**
 * The sweep's one safety gate: a tier flip only ever follows a verified
 * copy, and one candidate's failure (a bad hash or a thrown fetch/write
 * error) is recorded and skipped rather than aborting the run.
 */
export async function processCandidate(
  candidate: KeepSetCandidate,
  source: CopySource,
  destination: CopyDestination,
  setTier: (flashId: number, tier: string) => Promise<void>
): Promise<ProcessResult> {
  try {
    const outcome = await copyCandidateToKeepTier(candidate, source, destination);
    if (!outcome.verified) {
      return { promoted: false, failure: { flashId: candidate.flash_id, reason: "sha256 mismatch after write" } };
    }
    await setTier(candidate.flash_id, "keep");
    return { promoted: true };
  } catch (error) {
    return {
      promoted: false,
      failure: { flashId: candidate.flash_id, reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Runs `worker` over `items` with at most `limit` in flight at once,
 * returning results in input order. Each worker call is independent, so a
 * rejection propagates for that slot only if `worker` itself throws —
 * processCandidate never does, it reports failures instead.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    results[index] = await worker(items[index]);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  const dryRun = process.argv.includes("--dry-run");
  const pool = getPool();
  const flashesDb = new PostgresFlashesDb(pool);

  try {
    const candidates = await flashesDb.getKeepSetCandidates();

    if (dryRun) {
      console.log(`Keep set: ${candidates.length} rows`);
      console.log("Sample:", JSON.stringify(candidates.slice(0, 10), null, 2));
      return;
    }

    const pending = selectPending(candidates);
    log.info(`keep set: ${candidates.length} rows, ${pending.length} pending promotion`);

    const bucket = requireEnv("B2_BUCKET");
    const client = new S3Client({
      endpoint: requireEnv("B2_S3_ENDPOINT"),
      region: requireEnv("B2_REGION"),
      credentials: {
        accessKeyId: requireEnv("B2_PROMOTE_KEY_ID"),
        secretAccessKey: requireEnv("B2_PROMOTE_KEY"),
      },
    });
    const rateLimiter = new RateLimiter(intEnv("PROMOTE_RATE_LIMIT", 600));
    const gatewayUrl = optionalEnv("PINATA_GATEWAY", DEFAULT_PINATA_GATEWAY);
    const source = buildSource(client, bucket, rateLimiter, gatewayUrl);
    const destination = buildDestination(client, bucket);
    const concurrency = intEnv("PROMOTE_CONCURRENCY", 8);

    const results = await runWithConcurrency(pending, concurrency, (candidate) =>
      processCandidate(candidate, source, destination, (flashId, tier) => flashesDb.setImageTier(pool, flashId, tier))
    );

    const failures = results.flatMap((result) => (result.failure ? [result.failure] : []));
    const promoted = results.filter((result) => result.promoted).length;

    const summary: PromoteSummary = {
      total: candidates.length,
      alreadyKept: candidates.length - pending.length,
      promoted,
      failures,
    };
    console.log(formatSummary(summary));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await closePool();
    await closeLoggers();
  }
}

if (require.main === module) {
  main().catch((error) => {
    log.error(error);
    process.exitCode = 1;
  });
}
