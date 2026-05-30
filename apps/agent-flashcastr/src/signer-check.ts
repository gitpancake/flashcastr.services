import { NobleEd25519Signer } from '@farcaster/core';
import { decrypt } from '@life-os/shared';

const stripHexPrefix = (hex: string): string => (hex.startsWith('0x') ? hex.slice(2) : hex);

export interface SignerCheckResult {
  /** True when the signer decrypts and derives a valid Ed25519 public key. */
  ok: boolean;
  /** Human-readable failure cause when ok is false. */
  reason?: string;
  /** Derived Ed25519 public key (0x-hex) when ok. */
  publicKeyHex?: string;
  /**
   * Best-effort Hub check: true/false when the Hub answered, undefined when the
   * Hub was unreachable. false means the derived key is NOT among the FID's
   * active on-chain signers — casts will be rejected by the network.
   */
  activeOnHub?: boolean;
}

/**
 * Validate the @flashcastr signer at boot. Catches the most common silent
 * failure: a FARCASTER_ENCRYPTION_KEY that doesn't match the one the signer was
 * encrypted with (e.g. after migrating the row to a new deploy), which otherwise
 * only surfaces as a cryptic error on the first publish/like.
 *
 * Decrypts the stored key, confirms it's a 32-byte Ed25519 private key that
 * derives a public key, then — best effort — asks the Hub whether that public
 * key is an active on-chain signer for the FID.
 */
export async function validateSigner(
  encryptedSignerKey: string,
  encryptionKey: string | undefined,
  fid: number,
  hubHttpUrl: string,
): Promise<SignerCheckResult> {
  if (!encryptionKey) return { ok: false, reason: 'FARCASTER_ENCRYPTION_KEY not set' };

  let privHex: string;
  try {
    privHex = stripHexPrefix(decrypt(encryptedSignerKey, encryptionKey));
  } catch (err) {
    return { ok: false, reason: `decrypt failed (FARCASTER_ENCRYPTION_KEY mismatch?): ${(err as Error).message}` };
  }

  const keyBytes = Buffer.from(privHex, 'hex');
  if (keyBytes.length !== 32) {
    return { ok: false, reason: `decrypted signer key is ${keyBytes.length} bytes, expected 32` };
  }

  const signer = new NobleEd25519Signer(keyBytes);
  const keyResult = await signer.getSignerKey();
  if (keyResult.isErr()) {
    return { ok: false, reason: `Ed25519 key derivation failed: ${keyResult.error.message}` };
  }
  const publicKeyHex = '0x' + Buffer.from(keyResult.value).toString('hex');

  let activeOnHub: boolean | undefined;
  try {
    const res = await fetch(`${hubHttpUrl.replace(/\/$/, '')}/v1/onChainSignersByFid?fid=${fid}`);
    if (res.ok) {
      const data = await res.json() as { events?: Array<{ signerEventBody?: { key?: string } }> };
      const activeKeys = (data.events ?? [])
        .map(e => e.signerEventBody?.key?.toLowerCase())
        .filter((k): k is string => Boolean(k));
      activeOnHub = activeKeys.includes(publicKeyHex.toLowerCase());
    }
  } catch {
    // Hub unreachable — leave activeOnHub undefined; decrypt/derive already passed.
  }

  return { ok: true, publicKeyHex, activeOnHub };
}
