import { EventEmitter } from "events";

// Simple in-memory PubSub for GraphQL subscriptions
// Backed by EventEmitter — messages come from RabbitMQ consumer in main.ts

export const TOPICS = {
  FLASH_STORED: "FLASH_STORED",
  FLASH_CASTED: "FLASH_CASTED",
} as const;

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function publish(topic: string, payload: unknown): void {
  emitter.emit(topic, payload);
}

export function subscribe(topic: string): AsyncGenerator<unknown> {
  const pullQueue: Array<(value: IteratorResult<unknown>) => void> = [];
  const pushQueue: unknown[] = [];
  let done = false;

  const handler = (payload: unknown) => {
    if (pullQueue.length > 0) {
      pullQueue.shift()!({ value: payload, done: false });
    } else {
      pushQueue.push(payload);
    }
  };

  emitter.on(topic, handler);

  const generator: AsyncGenerator<unknown> = {
    next() {
      if (done) return Promise.resolve({ value: undefined, done: true });
      if (pushQueue.length > 0) {
        return Promise.resolve({ value: pushQueue.shift()!, done: false });
      }
      return new Promise((resolve) => pullQueue.push(resolve));
    },
    return() {
      done = true;
      emitter.off(topic, handler);
      for (const resolve of pullQueue) {
        resolve({ value: undefined, done: true });
      }
      pullQueue.length = 0;
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err) {
      done = true;
      emitter.off(topic, handler);
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return generator;
}
