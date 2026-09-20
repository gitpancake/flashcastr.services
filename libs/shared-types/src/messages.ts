export interface FlashReceivedPayload {
  flash_id: number;
  img: string;
  city: string;
  text: string;
  player: string;
  timestamp: number;
  flash_count: string;
}

export interface ImagePinnedPayload extends FlashReceivedPayload {
  ipfs_cid: string;
  ipfs_url: string;
}

export interface FlashStoredPayload extends ImagePinnedPayload {
  db_flash_id: number;
  stored_at: number;
  image_url: string | null;
}

export interface FlashCastedPayload extends FlashStoredPayload {
  cast_hash: string | null;
  user_fid: number;
  user_username: string;
  auto_cast: boolean;
}

