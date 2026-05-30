import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MentionRow } from './farcaster-ingest.js';

/** Reject bodies larger than this — a real cast.created payload is a few KB. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Verify Neynar's `X-Neynar-Signature` header: a hex-encoded HMAC-SHA512 of
 * the RAW request body keyed by the webhook's signing secret. Constant-time
 * compare. Returns false (never throws) on a missing header, a malformed hex
 * digest, or any length mismatch — the caller maps false → 401.
 */
export function verifyNeynarSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');

  // timingSafeEqual throws on differing lengths — guard first so a wrong-length
  // forged signature is a clean false, not an exception.
  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

interface NeynarWebhookBody {
  type?: string;
  data?: {
    hash?: string;
    parent_hash?: string | null;
    thread_hash?: string | null;
    text?: string;
    author?: { fid?: number; username?: string };
  };
}

/**
 * Map a Neynar `cast.created` webhook body to a MentionRow. Field paths
 * (`data.hash`, `data.author.fid|username`, `data.parent_hash`,
 * `data.thread_hash`, `data.text`) mirror the poll's notification mapping in
 * farcaster-ingest.ts. Returns null for any non-cast.created event or a
 * payload missing the dedup key / author fid — caller acks those with 200
 * (ignored) rather than 4xx, so Neynar doesn't enter a retry loop.
 *
 * `kind` is derived structurally: a cast with a parent_hash is a reply,
 * otherwise a top-level mention. (kind is stored for analytics only — the
 * reply pipeline does not branch on it.)
 */
export function parseWebhookCast(body: unknown): MentionRow | null {
  const evt = body as NeynarWebhookBody;
  if (evt?.type !== 'cast.created') return null;

  const cast = evt.data;
  if (!cast?.hash || !cast.author?.fid) return null;

  return {
    castHash: cast.hash,
    authorFid: cast.author.fid,
    authorUsername: cast.author.username ?? `fid:${cast.author.fid}`,
    parentHash: cast.parent_hash ?? null,
    threadRootHash: cast.thread_hash ?? cast.hash,
    text: cast.text ?? '',
    kind: cast.parent_hash ? 'reply' : 'mention',
  };
}

export interface WebhookServerOptions {
  secret: string;
  /**
   * Persist one inbound cast. Resolves true if a NEW row was written, false
   * on a duplicate (webhook+poll double-delivery) or a self-authored cast.
   * Must be fast (a single DB insert) — it runs before the 2xx is sent.
   */
  persist: (row: MentionRow) => Promise<boolean>;
  /** Drain the just-persisted row off-request (the AI reply runs on the tick). */
  triggerTick: () => void;
  /** Bumped once per accepted, signature-valid cast.created. */
  onReceived?: () => void;
  /** Bumped once per rejected request (missing/invalid signature). */
  onRejected?: () => void;
  /** Called with the first raw body seen, once, for field-path confirmation. */
  onFirstPayload?: (raw: string) => void;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * HTTP receiver for Neynar `cast.created` pushes. Lives entirely inside
 * setupPush — base.ts has no general route system; the metrics/health server
 * is a separate process on METRICS_PORT. This server binds Railway's public
 * `process.env.PORT`.
 *
 * Request contract:
 *  - GET  → 200 "ok" (liveness for the public Railway domain).
 *  - POST, bad/missing X-Neynar-Signature → 401 (onRejected bumped).
 *  - POST, valid signature, non-cast.created or unparseable → 200 (ignored).
 *  - POST, valid signature, cast.created → persist (await, fast) → 200 →
 *    triggerTick(). The AI reply/like run off-request on the next tick so a
 *    slow model call can never provoke a Neynar retry-storm.
 *  - Oversized body → 413. Any unexpected error → 500. Never throws out.
 */
export function createWebhookServer(opts: WebhookServerOptions): { server: Server; close: () => Promise<void> } {
  let firstPayloadLogged = false;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }

      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end('Method Not Allowed');
        return;
      }

      const rawBody = await readRawBody(req);
      if (rawBody === null) {
        res.statusCode = 413;
        res.end('Payload Too Large');
        return;
      }

      const signature = req.headers['x-neynar-signature'];
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!verifyNeynarSignature(rawBody, sig, opts.secret)) {
        opts.onRejected?.();
        console.warn('[agent-flashcastr] Webhook rejected — missing/invalid X-Neynar-Signature');
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }

      if (!firstPayloadLogged) {
        firstPayloadLogged = true;
        opts.onFirstPayload?.(rawBody.toString('utf8'));
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        // Signature was valid but body isn't JSON — ack so Neynar doesn't retry.
        res.statusCode = 200;
        res.end('ok');
        return;
      }

      const row = parseWebhookCast(parsed);
      if (!row) {
        // Valid but not a cast.created we handle — ack and ignore.
        res.statusCode = 200;
        res.end('ok');
        return;
      }

      // Persist BEFORE responding (fast DB insert). Dedup on the cast_hash PK
      // makes a webhook+poll double-delivery exactly-once by construction.
      await opts.persist(row);
      opts.onReceived?.();

      res.statusCode = 200;
      res.end('ok');

      // Off-request: drain via the normal tick so the AI reply + like never
      // gate the HTTP response.
      opts.triggerTick();
    } catch (err) {
      console.error('[agent-flashcastr] Webhook handler error:', (err as Error).message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
