import { EventEmitter } from "events";

export const TOPICS = {
  FLASH_STORED: "FLASH_STORED",
  FLASH_CASTED: "FLASH_CASTED",
} as const;

const MAX_BUFFERED_EVENTS_PER_SUBSCRIBER = 1000;

export interface PubSubEngine {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string): AsyncIterable<unknown>;
}

/**
 * Process-local pub/sub backing GraphQL subscriptions. Per-subscriber
 * pull/push queue capped at MAX_BUFFERED_EVENTS_PER_SUBSCRIBER; older events
 * are dropped once a subscriber falls behind.
 */
export class InMemoryPubSub implements PubSubEngine {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(topic: string, payload: unknown): void {
    this.emitter.emit(topic, payload);
  }

  subscribe(topic: string): AsyncGenerator<unknown> {
    const pullQueue: Array<(value: IteratorResult<unknown>) => void> = [];
    const pushQueue: unknown[] = [];
    let done = false;

    const handler = (payload: unknown) => {
      if (pullQueue.length > 0) {
        pullQueue.shift()!({ value: payload, done: false });
        return;
      }
      pushQueue.push(payload);
      if (pushQueue.length > MAX_BUFFERED_EVENTS_PER_SUBSCRIBER) pushQueue.shift();
    };

    const finish = () => {
      done = true;
      this.emitter.off(topic, handler);
      for (const resolve of pullQueue) resolve({ value: undefined, done: true });
      pullQueue.length = 0;
      pushQueue.length = 0;
    };

    this.emitter.on(topic, handler);

    const generator: AsyncGenerator<unknown> = {
      next() {
        if (done) return Promise.resolve({ value: undefined, done: true });
        if (pushQueue.length > 0) {
          return Promise.resolve({ value: pushQueue.shift()!, done: false });
        }
        return new Promise((resolve) => pullQueue.push(resolve));
      },
      return() {
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(err) {
        finish();
        return Promise.reject(err);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    return generator;
  }
}
