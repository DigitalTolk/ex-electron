import { describe, expect, it } from 'vitest';
import { parseUnreadCount } from '../src/lib/title';

describe('parseUnreadCount', () => {
  it('extracts a leading (N) prefix', () => {
    expect(parseUnreadCount('(3) Inbox · ex')).toBe(3);
    expect(parseUnreadCount('(42) Channels · ex')).toBe(42);
  });

  it('handles no prefix', () => {
    expect(parseUnreadCount('Inbox · ex')).toBe(0);
  });

  it('ignores prefix anywhere but the start', () => {
    expect(parseUnreadCount('Inbox (5) · ex')).toBe(0);
  });

  it('handles missing or weird whitespace', () => {
    expect(parseUnreadCount('(7)Inbox')).toBe(7);
    expect(parseUnreadCount('(0) Inbox')).toBe(0);
  });

  it('handles empty title', () => {
    expect(parseUnreadCount('')).toBe(0);
  });
});
