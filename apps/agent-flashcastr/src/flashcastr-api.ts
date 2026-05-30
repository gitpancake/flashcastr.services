export interface FlashcastrUser {
  fid: number;
  username: string;
}

export interface UnifiedFlash {
  flash_id: number;
  city: string;
  player: string;
  timestamp: string;
  /** IPFS content hash of the real flash photo. Pinned by flashcastr; null when no image. */
  ipfs_cid?: string | null;
  farcaster_user: {
    fid: number;
    username: string;
    cast_hash: string | null;
  } | null;
}

/**
 * Default IPFS gateway — the project Pinata gateway flashcastr's own web app
 * resolves photos through (`src/lib/help/getImageUrl.ts`). Overridable via
 * FLASHCASTR_IPFS_GATEWAY (e.g. a public gateway). The base must NOT include
 * a trailing `/ipfs` — `flashPhotoUrl` appends `/ipfs/<cid>`.
 */
const DEFAULT_IPFS_GATEWAY = 'https://fuchsia-rich-lungfish-648.mypinata.cloud';

/**
 * Canonical, content-addressed photo URL for a flash — the exact image the
 * flashcastr app itself renders. Never AI-generated/guessed: the URL is built
 * deterministically from the API-supplied `ipfs_cid`, so this adds no
 * hallucination surface. Returns null when the flash has no pinned image
 * (the embed resolver then no-ops and the cast stays text-only).
 */
export function flashPhotoUrl(
  flash: { ipfs_cid?: string | null },
  gateway: string = process.env.FLASHCASTR_IPFS_GATEWAY || DEFAULT_IPFS_GATEWAY,
): string | null {
  const cid = flash.ipfs_cid?.trim();
  if (!cid) return null;
  const base = gateway.replace(/\/+$/, '').replace(/\/ipfs$/, '');
  return `${base}/ipfs/${cid}`;
}

async function graphqlQuery(apiUrl: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Flashcastr API ${response.status}: ${response.statusText}`);
  const data = await response.json() as { data?: any; errors?: Array<{ message: string }> };
  if (data.errors?.length) throw new Error(`GraphQL: ${data.errors[0].message}`);
  return data.data;
}

export async function fetchFlashcasterUsers(apiUrl: string): Promise<FlashcastrUser[]> {
  const data = await graphqlQuery(apiUrl, `{ users { fid username } }`);
  return (data.users ?? []).filter((u: any) => u.fid && u.username);
}

export async function fetchUserFlashes(apiUrl: string, username: string): Promise<UnifiedFlash[]> {
  const data = await graphqlQuery(apiUrl, `
    query ($player: String, $limit: Int) {
      unifiedFlashes(player: $player, limit: $limit) {
        flash_id city player timestamp ipfs_cid
        farcaster_user { fid username cast_hash }
      }
    }
  `, { player: username, limit: 50 });
  return data.unifiedFlashes ?? [];
}
