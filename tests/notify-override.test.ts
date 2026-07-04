import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_ACTIVATED_EVENT, NOTIFY_OVERRIDE_SOURCE } from '../src/lib/notify-override';

describe('notification icon stripper', () => {
  let calls: Array<{ title: string; opts: NotificationOptions | undefined }>;
  let listeners: Array<{ type: string; handler: () => void }>;
  let dispatched: Event[];

  beforeEach(() => {
    calls = [];
    listeners = [];
    dispatched = [];
    class FakeNotification {
      static permission = 'granted';
      static maxActions = 2;
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
      constructor(title: string, opts?: NotificationOptions) {
        calls.push({ title, opts });
      }
      addEventListener(type: string, handler: () => void) {
        listeners.push({ type, handler });
      }
    }
    (globalThis as any).window = globalThis;
    (globalThis as any).Notification = FakeNotification;
    (globalThis as any).document = {
      dispatchEvent: (event: Event) => {
        dispatched.push(event);
        return true;
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).Notification;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
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

  it('a notification click dispatches the activation event on document', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    new (globalThis as any).Notification('Hello', { body: 'world' });
    expect(listeners).toHaveLength(1);
    expect(listeners[0].type).toBe('click');
    listeners[0].handler();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe(NOTIFICATION_ACTIVATED_EVENT);
  });

  it('a click with a torn-down document is swallowed, not thrown', () => {
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    new (globalThis as any).Notification('Hello');
    (globalThis as any).document = {
      dispatchEvent: () => {
        throw new Error('document gone');
      },
    };
    expect(() => listeners[0].handler()).not.toThrow();
  });

  it('tolerates notification instances without addEventListener', () => {
    class MinimalNotification {
      static permission = 'granted';
      static maxActions = 0;
      static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
      constructor(title: string, opts?: NotificationOptions) {
        calls.push({ title, opts });
      }
    }
    (globalThis as any).Notification = MinimalNotification;
    new Function(NOTIFY_OVERRIDE_SOURCE)();
    expect(() => new (globalThis as any).Notification('Hi')).not.toThrow();
    expect(calls).toHaveLength(1);
  });
});
