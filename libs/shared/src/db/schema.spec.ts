import { describe, it, expect } from 'vitest';
import { processSyncState, notifications } from './schema.js';

describe('database schema', () => {
  it('processSyncState has required columns', () => {
    const columns = Object.keys(processSyncState);
    expect(columns).toContain('processName');
    expect(columns).toContain('syncToken');
    expect(columns).toContain('lastSyncAt');
  });

  it('notifications has required columns', () => {
    const columns = Object.keys(notifications);
    expect(columns).toContain('id');
    expect(columns).toContain('eventId');
    expect(columns).toContain('title');
    expect(columns).toContain('body');
    expect(columns).toContain('channel');
    expect(columns).toContain('read');
    expect(columns).toContain('createdAt');
    expect(columns).toContain('readAt');
  });
});
