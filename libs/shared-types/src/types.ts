export interface Flash {
  flash_id: number;
  img: string;
  city: string;
  text: string;
  player: string;
  timestamp: number;
  flash_count: string;
  ipfs_cid?: string;
}

export interface FlashcastrFlash {
  flash_id: number;
  user_fid: number;
  user_username: string;
  user_pfp_url: string;
  cast_hash: string | null;
}

export interface FlashcastrUser {
  fid: number;
  username: string;
  signer_uuid: string;
  auto_cast: boolean;
}
