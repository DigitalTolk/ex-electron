// AwayMonitor decides whether a human is at this machine, from OS truth the
// web page cannot see: powerMonitor's system idle clock plus lock/unlock and
// suspend/resume events. The chat SPA consumes the verdict through the
// presence bridge (see presence-bridge.ts) and stops acknowledging desktop
// notification delivery the moment we say "away" — which is what routes
// alerts to the user's phone (the SPA's ack-gated mobile fallback).
//
// Architecture follows Mattermost desktop's UserActivityMonitor: poll
// `powerMonitor.getSystemIdleTime()` once per second, call the user inactive
// after 60 seconds of no OS input, and treat lock/suspend as immediate
// hard-away (Slack's "phone buzzes one minute after locking the screen" fast
// path). While active, the state is re-asserted periodically so the SPA's
// input-recency clock stays fresh from OS-level input alone.
//
// The monitor is deliberately deps-injected (like dnd-state's DndStateDeps)
// so tests can drive the poll with fake timers and a scripted idle clock.

export type PresenceState = 'active' | 'idle' | 'locked' | 'suspended' | 'unsupported';

// Poll cadence for the OS idle clock (Mattermost: 1s).
export const AWAY_POLL_INTERVAL_MS = 1_000;
// OS input silence that counts as "not at the desktop" (Mattermost: 60s).
export const AWAY_IDLE_THRESHOLD_SEC = 60;
// While continuously active, re-emit 'active' this often so the page's
// attention clock keeps getting stamped from OS input it can't observe.
export const AWAY_ACTIVE_REASSERT_MS = 60_000;

export interface AwayMonitorDeps {
  platform: NodeJS.Platform;
  // Seconds since the last OS-level input (powerMonitor.getSystemIdleTime).
  getSystemIdleTime: () => number;
  now?: () => number;
}

export class AwayMonitor {
  private readonly deps: AwayMonitorDeps;
  private readonly listeners = new Set<(state: PresenceState) => void>();
  private locked = false;
  private suspended = false;
  private state: PresenceState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActiveEmitAt = 0;

  constructor(deps: AwayMonitorDeps) {
    this.deps = deps;
    this.state = this.compute();
  }

  // current returns the latest computed state (also the pull-query answer).
  current(): PresenceState {
    return this.state;
  }

  // onChange subscribes to state emissions; returns an unsubscribe.
  onChange(cb: (state: PresenceState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // start begins the 1 Hz idle poll and emits the initial verdict so the
  // bridge stamps the page immediately. Idempotent.
  start(): void {
    if (this.timer) return;
    this.emit(this.state, true);
    this.timer = setInterval(() => this.evaluate(), AWAY_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Event hooks — wired to powerMonitor in main.ts. Lock/suspend are
  // immediate hard-away; unlock/resume re-evaluate (the idle clock decides
  // whether the human is really back — waking a machine is not input).
  handleLockScreen(): void {
    this.locked = true;
    this.evaluate();
  }

  handleUnlockScreen(): void {
    this.locked = false;
    this.evaluate();
  }

  handleSuspend(): void {
    this.suspended = true;
    this.evaluate();
  }

  handleResume(): void {
    this.suspended = false;
    this.evaluate();
  }

  private compute(): PresenceState {
    // Linux idle readings are unreliable (Wayland can report 0 forever or
    // miss keyboard input entirely — electron#27912/#34826) and the lock
    // events don't exist there. Report 'unsupported' so the page's own web
    // heuristics govern — never fake 'active' (would wrongly ack) nor
    // 'idle' (would buzz the phone of a user who IS at the desk).
    if (this.deps.platform === 'linux') return 'unsupported';
    if (this.locked) return 'locked';
    if (this.suspended) return 'suspended';
    let idleSec: number;
    try {
      idleSec = this.deps.getSystemIdleTime();
    } catch {
      // A broken idle source can't vouch either way — same posture as Linux.
      return 'unsupported';
    }
    return idleSec >= AWAY_IDLE_THRESHOLD_SEC ? 'idle' : 'active';
  }

  private evaluate(): void {
    const next = this.compute();
    if (next !== this.state) {
      this.state = next;
      this.emit(next, true);
      return;
    }
    // Steady 'active' still re-asserts periodically: each emission stamps the
    // page's input-recency clock, which would otherwise expire during a long
    // stretch of OS activity that never touches the chat window.
    if (next === 'active') {
      const now = this.deps.now?.() ?? Date.now();
      if (now - this.lastActiveEmitAt >= AWAY_ACTIVE_REASSERT_MS) {
        this.emit(next, true);
      }
    }
  }

  private emit(state: PresenceState, stampActive: boolean): void {
    if (stampActive && state === 'active') {
      this.lastActiveEmitAt = this.deps.now?.() ?? Date.now();
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(state);
      } catch {
        // One bad listener must not stall the poll or starve the others.
      }
    }
  }
}
