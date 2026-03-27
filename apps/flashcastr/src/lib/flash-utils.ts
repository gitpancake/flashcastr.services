import { IPFS_GATEWAY } from "./constants";
import type {
  UnifiedFlash,
  FlashcastrFlash,
  NormalizedFlash,
} from "@/types/flash";

export function getImageUrl(ipfs_cid: string): string {
  return `${IPFS_GATEWAY}/${ipfs_cid}`;
}

export function parseTimestamp(ts: string | null): number | null {
  if (!ts) return null;
  const parsed = parseInt(ts, 10);
  return isNaN(parsed) ? null : parsed;
}

export function formatTimeAgo(timestampSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestampSeconds;

  if (diff < 60) return "JUST NOW";
  if (diff < 3600) return `${Math.floor(diff / 60)}M AGO`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} HR AGO`;
  if (diff < 172800) return "YESTERDAY";
  return `${Math.floor(diff / 86400)} DAYS AGO`;
}

export function normalizeUnifiedFlash(f: UnifiedFlash): NormalizedFlash {
  return {
    flash_id: f.flash_id,
    ipfs_cid: f.ipfs_cid!,
    city: f.city,
    player: f.player,
    timestamp: f.timestamp,
    text: f.text,
    flash_count: f.flash_count,
    username: f.farcaster_user?.username ?? null,
    pfp_url: f.farcaster_user?.pfp_url ?? null,
    cast_hash: f.farcaster_user?.cast_hash ?? null,
    identification: f.identification,
  };
}

export function normalizeFlashcastrFlash(f: FlashcastrFlash): NormalizedFlash {
  return {
    flash_id: f.flash_id,
    ipfs_cid: f.flash.ipfs_cid!,
    city: f.flash.city,
    player: f.flash.player,
    timestamp: f.flash.timestamp,
    text: f.flash.text,
    flash_count: f.flash.flash_count,
    username: f.user_username,
    pfp_url: f.user_pfp_url,
    cast_hash: f.cast_hash,
    identification: null,
  };
}
