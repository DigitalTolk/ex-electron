import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWAY_ACTIVE_REASSERT_MS,
  AWAY_IDLE_THRESHOLD_SEC,
  AWAY_POLL_INTERVAL_MS,
  AwayMonitor,
  type PresenceState,
} from '../src/lib/away-monitor';

function makeMonitor(opts?: {
  platform?: NodeJS.Platform;
  idle?: () => number;
}) {
  const states: PresenceState[] = [];
  const monitor = new AwayMonitor({
    platform: opts?.platform ?? 'darwin',
    getSystemIdleTime: opts?.idle ?? (() => 0),
  });
  monitor.onChange((s) => states.push(s));
  return { monitor, states };
}

describe('AwayMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the initial verdict on start and is idempotent', () => {
    const { monitor, states } = makeMonitor();
    monitor.stop(); // stop before start: harmless no-op
    monitor.start();
    monitor.start();
    expect(states).toEqual(['active']);
    expect(monitor.current()).toBe('active');
    monitor.stop();
  });

  it('flips to idle once the OS idle clock passes the threshold, and back on input', () => {
    let idleSec = 0;
    const { monitor, states } = makeMonitor({ idle: () => idleSec });
    monitor.start();
    idleSec = AWAY_IDLE_THRESHOLD_SEC - 1;
    vi.advanceTimersByTime(AWAY_POLL_INTERVAL_MS);
    expect(monitor.current()).toBe('active');
    idleSec = AWAY_IDLE_THRESHOLD_SEC;
    vi.advanceTimersByTime(AWAY_POLL_INTERVAL_MS);
    expect(monitor.current()).toBe('idle');
    idleSec = 0; // the user touched the mouse
    vi.advanceTimersByTime(AWAY_POLL_INTERVAL_MS);
    expect(monitor.current()).toBe('active');
    expect(states).toEqual(['active', 'idle', 'active']);
    monitor.stop();
  });

  it('lock and suspend are immediate hard-away, released by their counterparts', () => {
    const { monitor, states } = makeMonitor();
    monitor.start();
    monitor.handleLockScreen();
    expect(monitor.current()).toBe('locked');
    monitor.handleUnlockScreen();
    expect(monitor.current()).toBe('active');
    monitor.handleSuspend();
    expect(monitor.current()).toBe('suspended');
    monitor.handleResume();
    expect(monitor.current()).toBe('active');
    expect(states).toEqual(['active', 'locked', 'active', 'suspended', 'active']);
    monitor.stop();
  });

  it('lock outranks suspend outranks idle', () => {
    let idleSec = AWAY_IDLE_THRESHOLD_SEC + 100;
    const { monitor } = makeMonitor({ idle: () => idleSec });
    monitor.handleSuspend();
    expect(monitor.current()).toBe('suspended');
    monitor.handleLockScreen();
    expect(monitor.current()).toBe('locked');
    monitor.handleUnlockScreen();
    expect(monitor.current()).toBe('suspended');
    monitor.handleResume();
    // Still idle: waking the machine is not input — the idle clock decides.
    expect(monitor.current()).toBe('idle');
    idleSec = 0;
    monitor.handleResume();
    expect(monitor.current()).toBe('active');
  });

  it('re-asserts a steady active periodically so the page clock stays fresh, without spamming', () => {
    const { monitor, states } = makeMonitor();
    monitor.start();
    expect(states).toEqual(['active']);
    // Just under the re-assert window: quiet.
    vi.advanceTimersByTime(AWAY_ACTIVE_REASSERT_MS - AWAY_POLL_INTERVAL_MS);
    expect(states).toEqual(['active']);
    // Crossing it: exactly one re-assertion.
    vi.advanceTimersByTime(AWAY_POLL_INTERVAL_MS);
    expect(states).toEqual(['active', 'active']);
    monitor.stop();
  });

  it('does NOT re-assert while away (idle emits only its transition)', () => {
    const { monitor, states } = makeMonitor({ idle: () => AWAY_IDLE_THRESHOLD_SEC + 5 });
    monitor.start();
    vi.advanceTimersByTime(AWAY_ACTIVE_REASSERT_MS * 3);
    expect(states.filter((s) => s === 'idle')).toHaveLength(1);
    monitor.stop();
  });

  it('reports unsupported on linux regardless of the idle clock or events', () => {
    const { monitor, states } = makeMonitor({ platform: 'linux', idle: () => 0 });
    monitor.start();
    monitor.handleLockScreen();
    vi.advanceTimersByTime(AWAY_POLL_INTERVAL_MS * 3);
    expect(monitor.current()).toBe('unsupported');
    expect(states).toEqual(['unsupported']);
    monitor.stop();
  });

  it('reports unsupported when the idle source throws (fail toward the web floor)', () => {
    const { monitor } = makeMonitor({
      idle: () => {
        throw new Error('powerMonitor unavailable');
      },
    });
    monitor.start();
    expect(monitor.current()).toBe('unsupported');
    monitor.stop();
  });

  it('a throwing listener does not starve the others', () => {
    const { monitor, states } = makeMonitor();
    monitor.onChange(() => {
      throw new Error('boom');
    });
    const late: PresenceState[] = [];
    monitor.onChange((s) => late.push(s));
    monitor.start();
    expect(states).toEqual(['active']);
    expect(late).toEqual(['active']);
    monitor.stop();
  });

  it('unsubscribe stops further emissions', () => {
    const monitor = new AwayMonitor({ platform: 'darwin', getSystemIdleTime: () => 0 });
    const seen: PresenceState[] = [];
    const off = monitor.onChange((s) => seen.push(s));
    monitor.start();
    off();
    monitor.handleLockScreen();
    expect(seen).toEqual(['active']);
    monitor.stop();
  });
});
