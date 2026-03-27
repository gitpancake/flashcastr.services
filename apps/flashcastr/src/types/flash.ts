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

export interface FlashcastrFlash {
  id: number;
  flash_id: string;
  user_fid: number;
  user_username: string | null;
  user_pfp_url: string | null;
  cast_hash: string | null;
  flash: {
    flash_id: string;
    city: string | null;
    player: string | null;
    img: string | null;
    ipfs_cid: string | null;
    text: string | null;
    timestamp: string | null;
    flash_count: string | null;
  };
}

/** Normalized flash for rendering — both feed types map into this shape */
export interface NormalizedFlash {
  flash_id: string;
  ipfs_cid: string;
  city: string | null;
  player: string | null;
  timestamp: string | null;
  text: string | null;
  flash_count: string | null;
  username: string | null;
  pfp_url: string | null;
  cast_hash: string | null;
  identification: FlashIdentificationInfo | null;
}

export type FeedMode = "global" | "players";
export type ViewMode = "small" | "medium" | "large";
