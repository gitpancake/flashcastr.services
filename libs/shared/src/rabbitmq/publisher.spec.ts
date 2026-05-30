import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPublisher } from './publisher.js';
import { EXCHANGE_NAME } from '../events/index.js';

describe('createPublisher', () => {
  let mockChannel: any;

  beforeEach(() => {
    mockChannel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockReturnValue(true),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('publishes event to correct exchange with routing key', async () => {
    const publisher = createPublisher(mockChannel);
    const event = {
      id: 'test-id',
      routingKey: 'life.email.received',
      timestamp: new Date().toISOString(),
      source: 'agent-email',
      payload: { subject: 'Test' },
    };

    await publisher.publish(event);

    expect(mockChannel.publish).toHaveBeenCalledWith(
      EXCHANGE_NAME,
      'life.email.received',
      Buffer.from(JSON.stringify(event)),
      { persistent: true, messageId: 'test-id' }
    );
  });
});
