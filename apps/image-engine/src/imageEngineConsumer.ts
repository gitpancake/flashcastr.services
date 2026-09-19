import type { ConsumeMessage } from "amqplib";
import { FlashcastrConsumer, QUEUES, type ConsumerOptions } from "@flashcastr/rabbitmq";
import { intEnv } from "@flashcastr/config";
import type { MessageEnvelope, FlashReceivedPayload } from "@flashcastr/shared-types";
import type { ImagePinner } from "./imagePinner.js";

export class ImageEngineConsumer extends FlashcastrConsumer<FlashReceivedPayload> {
  constructor(
    private readonly imagePinner: ImagePinner,
    options: ConsumerOptions = {}
  ) {
    super("image-engine", QUEUES.FLASH_RECEIVED, { maxAttempts: intEnv("CONSUMER_MAX_ATTEMPTS", 10), ...options });
  }

  protected override shouldRequeueOnFailure(error: Error): boolean {
    const msg = error.message.toLowerCase();
    if (msg.includes("already processed") || msg.includes("duplicate")) return false;
    return true;
  }

  protected async handleMessage(envelope: MessageEnvelope<FlashReceivedPayload>, _raw: ConsumeMessage): Promise<void> {
    await this.imagePinner.handle(envelope.payload, envelope.correlationId);
  }
}
