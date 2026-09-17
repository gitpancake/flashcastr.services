import { EventEmitter } from "events";

export const TOPICS = {
  FLASH_STORED: "FLASH_STORED",
  FLASH_CASTED: "FLASH_CASTED",
} as const;

const MAX_BUFFERED_EVENTS_PER_SUBSCRIBER = 1000;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish(topic: string, payload: unknown): void {
  emitter.emit(topic, payload);
}

export function subscriberCount(topic: string): number {
  return emitter.listenerCount(topic);
}

/**
 * Per-subscriber async iterator over a topic. A subscriber that stops pulling
 * keeps at most MAX_BUFFERED_EVENTS_PER_SUBSCRIBER events; older ones are dropped.
 */
export function subscribe(topic: string): AsyncGenerator<unknown> {
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
    emitter.off(topic, handler);
    for (const resolve of pullQueue) resolve({ value: undefined, done: true });
    pullQueue.length = 0;
    pushQueue.length = 0;
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
