import { describe, it, expect } from 'vitest';
import { createLifeEvent } from './types.js';

describe('createLifeEvent', () => {
  it('creates an event with UUID, timestamp, and provided fields', () => {
    const event = createLifeEvent({
      routingKey: 'life.email.received',
      source: 'agent-email',
      payload: { messageId: '123', subject: 'Hello' },
    });

    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(event.routingKey).toBe('life.email.received');
    expect(event.source).toBe('agent-email');
    expect(event.payload).toEqual({ messageId: '123', subject: 'Hello' });
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });
});
