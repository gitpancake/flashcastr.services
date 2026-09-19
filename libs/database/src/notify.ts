import type { Pool, PoolClient } from "pg";
import type { FlashStoredPayload, FlashCastedPayload } from "@flashcastr/shared-types";

export const NOTIFY_CHANNELS = {
  FLASH_STORED: "flash_stored",
  FLASH_CASTED: "flash_casted",
} as const;

export interface FlashStoredNotification {
  flash_id: string;
  city: string;
  player: string;
  img: string;
  ipfs_cid: string;
  timestamp: string;
}

export interface FlashCastedNotification {
  flash_id: string;
  city: string;
  player: string;
  cast_hash: string | null;
  user_fid: number;
  user_username: string;
}

export async function notifyFlashStored(executor: Pool | PoolClient, payload: FlashStoredPayload): Promise<void> {
  const notification: FlashStoredNotification = {
    flash_id: String(payload.flash_id),
    city: payload.city,
    player: payload.player,
    img: payload.img,
    ipfs_cid: payload.ipfs_cid,
    timestamp: String(payload.timestamp),
  };
  await executor.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNELS.FLASH_STORED, JSON.stringify(notification)]);
}

export async function notifyFlashCasted(executor: Pool | PoolClient, payload: FlashCastedPayload): Promise<void> {
  const notification: FlashCastedNotification = {
    flash_id: String(payload.flash_id),
    city: payload.city,
    player: payload.player,
    cast_hash: payload.cast_hash,
    user_fid: payload.user_fid,
    user_username: payload.user_username,
  };
  await executor.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNELS.FLASH_CASTED, JSON.stringify(notification)]);
}
