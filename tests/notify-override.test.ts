import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFY_OVERRIDE_SOURCE } from '../src/lib/notify-override';

describe('notification icon stripper', () => {
  let calls: Array<{ title: string; opts: NotificationOptions | undefined }>;

  beforeEach(() => {
    calls = [];
    class FakeNotification {
      static permission = 'granted';
      static maxActions = 2;
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
      constructor(title: string, opts?: NotificationOptions) {
        calls.push({ title, opts });
      }
    }
    (globalThis as any).window = globalThis;
    (globalThis as any).Notification = FakeNotification;
  });

  afterEach(() => {
    delete (globalThis as any).Notification;
    delete (globalThis as any).window;
  });

  it('strips icon, image, and badge and forces silent on notification options', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    new (globalThis as any).Notification('Hello', {
      body: 'world',
      icon: 'https://chat/avatar.png',
      image: 'https://chat/banner.png',
      badge: 'https://chat/badge.png',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe('Hello');
    expect(calls[0].opts).toEqual({ body: 'world', silent: true });
  });

  it('forces silent even when no options are given', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    new (globalThis as any).Notification('Hi');
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ silent: true });
  });

  it('overrides a falsy silent option from the page', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    new (globalThis as any).Notification('Hi', { body: 'b', silent: false } as NotificationOptions);
    expect(calls[0].opts).toEqual({ body: 'b', silent: true });
  });

  it('preserves the static permission and requestPermission API', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    expect((globalThis as any).Notification.permission).toBe('granted');
    expect(typeof (globalThis as any).Notification.requestPermission).toBe('function');
  });

  it('is idempotent — re-running does not double-wrap', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    const wrapped = (globalThis as any).Notification;
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    expect((globalThis as any).Notification).toBe(wrapped);
  });
});
