import { describe, it, expect, vi, afterEach } from 'vitest';
import { encrypt } from '@life-os/shared';
import { validateSigner } from './signer-check.js';

const AES_KEY = 'a'.repeat(64);        // 32-byte AES-256 key (hex)
const PRIV_HEX = '11'.repeat(32);      // 32-byte Ed25519 private scalar (hex)
const ENC = encrypt(PRIV_HEX, AES_KEY);

afterEach(() => vi.restoreAllMocks());

describe('validateSigner', () => {
  it('decrypts, derives an Ed25519 public key, and reports active=false when key absent from Hub', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [] }), { status: 200 })));
    const r = await validateSigner(ENC, AES_KEY, 1075183, 'https://hub');
    expect(r.ok).toBe(true);
    expect(r.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.activeOnHub).toBe(false);
  });

  it('reports activeOnHub=true when the derived key is an active on-chain signer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('hub down'); }));
    const probe = await validateSigner(ENC, AES_KEY, 1, 'https://hub');
    expect(probe.ok).toBe(true);
    expect(probe.activeOnHub).toBeUndefined(); // hub unreachable

    const key = probe.publicKeyHex!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [{ signerEventBody: { key } }] }), { status: 200 })));
    const r = await validateSigner(ENC, AES_KEY, 1, 'https://hub');
    expect(r.activeOnHub).toBe(true);
  });

  it('fails when the encryption key does not match (decrypt error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const r = await validateSigner(ENC, 'b'.repeat(64), 1, 'https://hub');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/decrypt failed/);
  });

  it('fails when FARCASTER_ENCRYPTION_KEY is unset', async () => {
    const r = await validateSigner(ENC, undefined, 1, 'https://hub');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not set/);
  });

  it('fails when the decrypted key is not 32 bytes', async () => {
    const shortEnc = encrypt('1234', AES_KEY); // 2 bytes
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const r = await validateSigner(shortEnc, AES_KEY, 1, 'https://hub');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expected 32/);
  });
});
