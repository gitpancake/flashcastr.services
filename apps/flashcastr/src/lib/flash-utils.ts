import { IPFS_GATEWAY } from "./constants";

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
