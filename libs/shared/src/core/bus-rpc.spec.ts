// LOS-546 — bus-rpc tests.
//
// Verifies:
//  • Single in-flight RPC resolves with the matching response.
//  • Concurrent RPCs each get their own response (no cross-talk).
//  • Mismatched correlation ids are dropped on the floor.
//  • Timeouts reject with a descriptive error.
//  • `correlationField` option lets callers use `requestId`-style payloads.

import { describe, it, expect } from 'vitest';
import { busRpc, type EventSubscriber } from './bus-rpc.js';
import type { EventPublisher } from '../rabbitmq/publisher.js';
import type { LifeEvent } from '../events/types.js';

interface FakeBus {
  publisher: EventPublisher;
  subscriber: EventSubscriber;
  /** Push a synthetic response onto a routing key. */
  emitResponse: (routingKey: string, payload: unknown) => void;
  publishCalls: Array<{ routingKey: string; payload: any }>;
  unsubscribeCalls: { count: number };
}

function makeFakeBus(): FakeBus {
  const handlers = new Map<string, Set<(e: LifeEvent) => void>>();
  const publishCalls: Array<{ routingKey: string; payload: any }> = [];
  const unsubscribeCalls = { count: 0 };

  const publisher: EventPublisher = {
    async publish(event) {
      publishCalls.push({ routingKey: event.routingKey, payload: event.payload as any });
    },
  };

  const subscriber: EventSubscriber = {
    async subscribe(routingKey, handler) {
      const set = handlers.get(routingKey) ?? new Set();
      set.add(handler);
      handlers.set(routingKey, set);
      return {
        async unsubscribe() {
          unsubscribeCalls.count++;
          set.delete(handler);
        },
      };
    },
  };

  const emitResponse = (routingKey: string, payload: unknown) => {
    const set = handlers.get(routingKey);
    if (!set) return;
    const event = { routingKey, payload, id: 'evt', source: 'test', timestamp: '' } as unknown as LifeEvent;
    for (const h of set) h(event);
  };

  return { publisher, subscriber, emitResponse, publishCalls, unsubscribeCalls };
}

const REQ = 'life.test.request';
const RES = 'life.test.response';

describe('busRpc', () => {
  it('resolves with the response whose correlationId matches the request', async () => {
    const bus = makeFakeBus();

    const promise = busRpc<{ q: string; correlationId: string }, { correlationId: string; answer: string }>(
      { publisher: bus.publisher, subscriber: bus.subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: { q: 'hello' } },
    );

    // Wait one tick so the helper publishes — the published payload carries the id.
    await new Promise((r) => setImmediate(r));
    const sentId = bus.publishCalls[0].payload.correlationId;
    expect(sentId).toBeTruthy();

    bus.emitResponse(RES, { correlationId: sentId, answer: 'world' });

    const result = await promise;
    expect(result.answer).toBe('world');
    expect(bus.unsubscribeCalls.count).toBe(1);
  });

  it('handles two concurrent RPCs without cross-talk', async () => {
    const bus = makeFakeBus();

    const p1 = busRpc<{ q: string; correlationId: string }, { correlationId: string; answer: string }>(
      { publisher: bus.publisher, subscriber: bus.subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: { q: 'one' } },
    );
    const p2 = busRpc<{ q: string; correlationId: string }, { correlationId: string; answer: string }>(
      { publisher: bus.publisher, subscriber: bus.subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: { q: 'two' } },
    );

    await new Promise((r) => setImmediate(r));
    const id1 = bus.publishCalls[0].payload.correlationId;
    const id2 = bus.publishCalls[1].payload.correlationId;
    expect(id1).not.toBe(id2);

    // Respond to the second request first to prove independence.
    bus.emitResponse(RES, { correlationId: id2, answer: 'second' });
    bus.emitResponse(RES, { correlationId: id1, answer: 'first' });

    expect((await p1).answer).toBe('first');
    expect((await p2).answer).toBe('second');
  });

  it('ignores responses with a non-matching correlationId', async () => {
    const bus = makeFakeBus();

    const promise = busRpc<{ correlationId: string }, { correlationId: string; answer: string }>(
      { publisher: bus.publisher, subscriber: bus.subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: {} },
      { timeoutMs: 200 },
    );

    await new Promise((r) => setImmediate(r));

    // Stray response from a different in-flight RPC — should be dropped.
    bus.emitResponse(RES, { correlationId: 'somebody-elses-id', answer: 'nope' });

    // Then the real response.
    const realId = bus.publishCalls[0].payload.correlationId;
    bus.emitResponse(RES, { correlationId: realId, answer: 'mine' });

    const result = await promise;
    expect(result.answer).toBe('mine');
  });

  it('rejects with a descriptive error on timeout', async () => {
    const bus = makeFakeBus();

    const promise = busRpc(
      { publisher: bus.publisher, subscriber: bus.subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: {} },
      { timeoutMs: 20 },
    );

    await expect(promise).rejects.toThrow(/timed out after 20ms/);
    // Subscription should be torn down on timeout.
    expect(bus.unsubscribeCalls.count).toBe(1);
  });

  it('does not lose the response when the responder replies synchronously after publish', async () => {
    // Regression test: an in-process responder (e.g. service-linear at ~1ms)
    // can publish its response immediately after seeing the request. The
    // helper must have its subscription bound before publish() returns, or
    // the response is dropped and the RPC times out.
    const handlers = new Map<string, Set<(e: LifeEvent) => void>>();
    const publishCalls: Array<{ routingKey: string; payload: any }> = [];

    const subscriber: EventSubscriber = {
      async subscribe(routingKey, handler) {
        const set = handlers.get(routingKey) ?? new Set();
        set.add(handler);
        handlers.set(routingKey, set);
        return { async unsubscribe() { set.delete(handler); } };
      },
    };

    const publisher: EventPublisher = {
      async publish(event) {
        publishCalls.push({ routingKey: event.routingKey, payload: event.payload as any });
        // Synchronous responder: the moment the request lands, fire the
        // matching response with the same correlation id. No setImmediate,
        // no microtask gap.
        const id = (event.payload as any).correlationId;
        const set = handlers.get(RES);
        if (set) {
          const response = { routingKey: RES, payload: { correlationId: id, answer: 'sync' }, id: 'evt', source: 'test', timestamp: '' } as unknown as LifeEvent;
          for (const h of set) h(response);
        }
      },
    };

    const result = await busRpc<{ correlationId: string }, { correlationId: string; answer: string }>(
      { publisher, subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: {} },
      { timeoutMs: 200 },
    );
    expect(result.answer).toBe('sync');
    expect(publishCalls).toHaveLength(1);
  });

  it('honours a custom correlationField (e.g. requestId)', async () => {
    const bus = makeFakeBus();

    const promise = busRpc<{ requestId: string }, { requestId: string; ok: boolean }>(
      { publisher: bus.publisher, subscriber: bus.subscriber, source: 'test' },
      { requestRoutingKey: REQ, responseRoutingKey: RES, payload: {} },
      { correlationField: 'requestId' },
    );

    await new Promise((r) => setImmediate(r));
    const sentId = bus.publishCalls[0].payload.requestId;
    expect(sentId).toBeTruthy();
    expect(bus.publishCalls[0].payload.correlationId).toBeUndefined();

    bus.emitResponse(RES, { requestId: sentId, ok: true });
    const result = await promise;
    expect(result.ok).toBe(true);
  });
});
