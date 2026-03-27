export interface FarcasterUser {
  fid: number;
  username: string | null;
  pfp_url: string | null;
  cast_hash: string | null;
}

export interface FlashIdentificationInfo {
  id: number;
  matched_flash_id: string;
  matched_flash_name: string | null;
  similarity: number;
  confidence: number;
}

export interface UnifiedFlash {
  flash_id: string;
  city: string | null;
  player: string | null;
  img: string | null;
  ipfs_cid: string | null;
  text: string | null;
  timestamp: string | null;
  flash_count: string | null;
  farcaster_user: FarcasterUser | null;
  identification: FlashIdentificationInfo | null;
}

export interface FlashStoredEvent {
  flash_id: string;
  city: string | null;
  player: string | null;
  img: string | null;
  ipfs_cid: string | null;
  timestamp: string | null;
}

export interface FlashCastedEvent {
  flash_id: string;
  city: string | null;
  player: string | null;
  cast_hash: string | null;
  user_fid: number | null;
  user_username: string | null;
}

export type ViewMode = "small" | "medium" | "large";
