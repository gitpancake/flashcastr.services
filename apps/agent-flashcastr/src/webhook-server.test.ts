import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  verifyNeynarSignature,
  parseWebhookCast,
  createWebhookServer,
  type WebhookServerOptions,
} from './webhook-server.js';

const SECRET = 'whsec_test_secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha512', secret).update(Buffer.from(body)).digest('hex');
}

const CAST_CREATED = JSON.stringify({
  type: 'cast.created',
  data: {
    hash: '0xinbound',
    parent_hash: '0xourcast',
    thread_hash: '0xroot',
    text: 'gm @flashcastr is PA_1099 up?',
    author: { fid: 111, username: 'alice' },
  },
});

describe('verifyNeynarSignature', () => {
  it('accepts a correct HMAC-SHA512 hex digest of the raw body', () => {
    const raw = Buffer.from(CAST_CREATED);
    expect(verifyNeynarSignature(raw, sign(CAST_CREATED), SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const raw = Buffer.from(CAST_CREATED);
    expect(verifyNeynarSignature(raw, sign(CAST_CREATED, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyNeynarSignature(Buffer.from(CAST_CREATED), undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed / wrong-length signature without throwing', () => {
    expect(verifyNeynarSignature(Buffer.from(CAST_CREATED), 'deadbeef', SECRET)).toBe(false);
    expect(verifyNeynarSignature(Buffer.from(CAST_CREATED), 'zzzz', SECRET)).toBe(false);
  });

  it('rejects when the body is tampered after signing', () => {
    const sig = sign(CAST_CREATED);
    expect(verifyNeynarSignature(Buffer.from(CAST_CREATED + ' '), sig, SECRET)).toBe(false);
  });
});

describe('parseWebhookCast', () => {
  it('maps a reply (parent_hash present) to a reply MentionRow', () => {
    expect(parseWebhookCast(JSON.parse(CAST_CREATED))).toEqual({
      castHash: '0xinbound',
      authorFid: 111,
      authorUsername: 'alice',
      parentHash: '0xourcast',
      threadRootHash: '0xroot',
      text: 'gm @flashcastr is PA_1099 up?',
      kind: 'reply',
    });
  });

  it('maps a top-level mention (no parent_hash) to a mention MentionRow', () => {
    const row = parseWebhookCast({
      type: 'cast.created',
      data: { hash: '0xm', text: 'hi @flashcastr', author: { fid: 7 } },
    });
    expect(row).toMatchObject({
      castHash: '0xm',
      kind: 'mention',
      authorUsername: 'fid:7',
      parentHash: null,
      threadRootHash: '0xm',
    });
  });

  it('returns null for a non-cast.created event', () => {
    expect(parseWebhookCast({ type: 'reaction.created', data: { hash: '0x1' } })).toBeNull();
  });

  it('returns null when the dedup key or author fid is missing', () => {
    expect(parseWebhookCast({ type: 'cast.created', data: { author: { fid: 1 } } })).toBeNull();
    expect(parseWebhookCast({ type: 'cast.created', data: { hash: '0x1' } })).toBeNull();
  });
});

describe('createWebhookServer', () => {
  let close: () => Promise<void>;
  let url: string;

  async function start(overrides: Partial<WebhookServerOptions> = {}) {
    const opts: WebhookServerOptions = {
      secret: SECRET,
      persist: vi.fn(async () => true),
      triggerTick: vi.fn(),
      onReceived: vi.fn(),
      onRejected: vi.fn(),
      ...overrides,
    };
    const { server, close: closeFn } = createWebhookServer(opts);
    close = closeFn;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;
    return opts;
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await close?.();
    vi.restoreAllMocks();
  });

  it('GET → 200 ok (liveness)', async () => {
    await start();
    const res = await fetch(url, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('valid signature + cast.created → persists, 200, triggers tick off-request', async () => {
    const opts = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-neynar-signature': sign(CAST_CREATED) },
      body: CAST_CREATED,
    });

    expect(res.status).toBe(200);
    expect(opts.persist).toHaveBeenCalledWith(
      expect.objectContaining({ castHash: '0xinbound', authorFid: 111, kind: 'reply' }),
    );
    expect(opts.onReceived).toHaveBeenCalledTimes(1);
    expect(opts.triggerTick).toHaveBeenCalledTimes(1);
    expect(opts.onRejected).not.toHaveBeenCalled();
  });

  it('missing/invalid signature → 401, onRejected, no persist, no tick', async () => {
    const opts = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-neynar-signature': 'badsig' },
      body: CAST_CREATED,
    });

    expect(res.status).toBe(401);
    expect(opts.onRejected).toHaveBeenCalledTimes(1);
    expect(opts.persist).not.toHaveBeenCalled();
    expect(opts.triggerTick).not.toHaveBeenCalled();
  });

  it('no signature header → 401', async () => {
    const opts = await start();
    const res = await fetch(url, { method: 'POST', body: CAST_CREATED });
    expect(res.status).toBe(401);
    expect(opts.persist).not.toHaveBeenCalled();
  });

  it('valid signature but non-cast.created → 200, ignored (no persist, no tick)', async () => {
    const body = JSON.stringify({ type: 'reaction.created', data: { hash: '0x1' } });
    const opts = await start();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-neynar-signature': sign(body) },
      body,
    });

    expect(res.status).toBe(200);
    expect(opts.persist).not.toHaveBeenCalled();
    expect(opts.triggerTick).not.toHaveBeenCalled();
  });

  it('duplicate delivery (persist → false) still 200 — exactly-once via PK dedup', async () => {
    const opts = await start({ persist: vi.fn(async () => false) });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-neynar-signature': sign(CAST_CREATED) },
      body: CAST_CREATED,
    });

    expect(res.status).toBe(200);
    expect(opts.persist).toHaveBeenCalledTimes(1);
  });

  it('logs the first raw payload once for field-path confirmation', async () => {
    const onFirstPayload = vi.fn();
    await start({ onFirstPayload });
    const headers = { 'x-neynar-signature': sign(CAST_CREATED) };
    await fetch(url, { method: 'POST', headers, body: CAST_CREATED });
    await fetch(url, { method: 'POST', headers, body: CAST_CREATED });
    expect(onFirstPayload).toHaveBeenCalledTimes(1);
    expect(onFirstPayload).toHaveBeenCalledWith(CAST_CREATED);
  });
});
