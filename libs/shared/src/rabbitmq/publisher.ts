import type { ConfirmChannel } from 'amqplib';
import type { LifeEvent } from '../events/index.js';
import { EXCHANGE_NAME } from '../events/index.js';

export interface EventPublisher {
  publish<T>(event: LifeEvent<T>): Promise<void>;
}

export function createPublisher(channel: ConfirmChannel): EventPublisher {
  return {
    async publish<T>(event: LifeEvent<T>): Promise<void> {
      channel.publish(
        EXCHANGE_NAME,
        event.routingKey,
        Buffer.from(JSON.stringify(event)),
        { persistent: true, messageId: event.id }
      );
      await channel.waitForConfirms();
    },
  };
}
