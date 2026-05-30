import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubscriber } from './subscriber.js';
import { EXCHANGE_NAME } from '../events/index.js';

describe('createSubscriber', () => {
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      assertQueue: vi.fn().mockResolvedValue({ queue: 'test-queue' }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn(),
      nack: vi.fn(),
      publish: vi.fn().mockReturnValue(true),
      sendToQueue: vi.fn().mockReturnValue(true),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
      prefetch: vi.fn(),
    };
  });

  it('binds queue to exchange with correct pattern', async () => {
    const handler = vi.fn();
    await createSubscriber(mockChannel, {
      queueName: 'service-notifications.email',
      patterns: ['life.email.*'],
      handler,
    });

    expect(mockChannel.assertQueue).toHaveBeenCalledWith(
      'service-notifications.email',
      expect.objectContaining({ durable: true })
    );
    expect(mockChannel.bindQueue).toHaveBeenCalledWith(
      'service-notifications.email',
      EXCHANGE_NAME,
      'life.email.*'
    );
  });

  it('acks message on successful handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    await createSubscriber(mockChannel, {
      queueName: 'test-queue',
      patterns: ['life.email.*'],
      handler,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const mockMsg = {
      content: Buffer.from(JSON.stringify({ id: '1', payload: {} })),
      properties: { headers: {} },
    };
    await consumeCallback(mockMsg);

    expect(mockChannel.ack).toHaveBeenCalledWith(mockMsg);
  });

  it('republishes with incremented retry count on handler failure', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('fail'));
    await createSubscriber(mockChannel, {
      queueName: 'test-queue',
      patterns: ['life.email.*'],
      handler,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const mockMsg = {
      content: Buffer.from(JSON.stringify({ id: '1', payload: {} })),
      fields: { routingKey: 'life.email.received' },
      properties: { headers: {} },
    };
    await consumeCallback(mockMsg);

    expect(mockChannel.ack).toHaveBeenCalledWith(mockMsg);
    expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
      'test-queue',
      expect.any(Buffer),
      expect.objectContaining({
        headers: { 'x-retry-count': 1 },
      })
    );
  });

  it('sends to DLQ after 3 retries', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('fail'));
    await createSubscriber(mockChannel, {
      queueName: 'test-queue',
      patterns: ['life.email.*'],
      handler,
    });

    const consumeCallback = mockChannel.consume.mock.calls[0][1];
    const mockMsg = {
      content: Buffer.from(JSON.stringify({ id: '1', payload: {} })),
      fields: { routingKey: 'life.email.received' },
      properties: { headers: { 'x-retry-count': 3 } },
    };
    await consumeCallback(mockMsg);

    expect(mockChannel.nack).toHaveBeenCalledWith(mockMsg, false, false);
  });
});
