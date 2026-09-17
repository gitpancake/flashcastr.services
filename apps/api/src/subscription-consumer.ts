import type { ConsumeMessage } from "amqplib";
import { FlashcastrConsumer, QUEUES, ROUTING_KEYS } from "@flashcastr/rabbitmq";
import type { FlashStoredPayload, FlashCastedPayload, MessageEnvelope } from "@flashcastr/shared-types";
import { publish, TOPICS } from "./pubsub.js";

const SUBSCRIPTION_PREFETCH = 10;

/**
 * Bridges RabbitMQ FLASH_STORED / FLASH_CASTED events into the in-process
 * pubsub that backs GraphQL subscriptions. Inherits reconnect handling from
 * FlashcastrConsumer; unknown event types are acked and ignored.
 */
export class SubscriptionConsumer extends FlashcastrConsumer<unknown> {
  constructor(rabbitUrl: string) {
    super("api", QUEUES.API_SUBSCRIPTIONS, { rabbitUrl, prefetch: SUBSCRIPTION_PREFETCH });
  }

  protected async handleMessage(envelope: MessageEnvelope<unknown>, _raw: ConsumeMessage): Promise<void> {
    if (envelope.type === ROUTING_KEYS.FLASH_STORED) {
      const payload = envelope.payload as FlashStoredPayload;
      publish(TOPICS.FLASH_STORED, {
        flash_id: String(payload.flash_id),
        city: payload.city,
        player: payload.player,
        img: payload.img,
        ipfs_cid: payload.ipfs_cid,
        timestamp: String(payload.timestamp),
      });
      return;
    }

    if (envelope.type === ROUTING_KEYS.FLASH_CASTED) {
      const payload = envelope.payload as FlashCastedPayload;
      publish(TOPICS.FLASH_CASTED, {
        flash_id: String(payload.flash_id),
        city: payload.city,
        player: payload.player,
        cast_hash: payload.cast_hash,
        user_fid: payload.user_fid,
        user_username: payload.user_username,
      });
    }
  }
}
