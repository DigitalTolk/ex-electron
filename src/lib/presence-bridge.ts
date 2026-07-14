// Presence bridge: mirrors the AwayMonitor's verdict (away-monitor.ts) into
// the chat page so the SPA's attention model gains OS truth — screen locked,
// system suspended, OS-idle — that page JavaScript cannot observe. Same
// world-crossing pattern as the DnD bridge (dnd-bridge.ts): the chat window
// exposes NO contextBridge, so state crosses via the shared DOM only —
//
//   main ── ipc 'presence:state' ──▶ preload (isolated world)
//                                     stamps data-ex-presence on <html>
//                                     fires ex:presence-changed
//                                             │
//   page (main world): reads the attribute on each event (the ex repo's
//   src/lib/desktop-presence.ts is the consumer contract).
//
// Push-based (unlike DnD's page-initiated query): away/lock transitions must
// reach the page the moment they happen, not when the page next asks. The
// preload additionally pulls the current state once at install so a page
// that loads mid-session starts from truth instead of "unknown".

export const PRESENCE_STATE_ATTR = 'data-ex-presence';
export const PRESENCE_CHANGED_EVENT = 'ex:presence-changed';
export const PRESENCE_IPC_CHANNEL = 'presence:state';

// The DOM surface the receiver needs — narrow so tests can fake it.
export interface PresenceDoc {
  dispatchEvent(event: Event): boolean;
  documentElement: {
    setAttribute(name: string, value: string): void;
  };
}

// applyPresenceState stamps the state and notifies the page.
export function applyPresenceState(doc: PresenceDoc, state: string): void {
  doc.documentElement.setAttribute(PRESENCE_STATE_ATTR, state);
  doc.dispatchEvent(new Event(PRESENCE_CHANGED_EVENT));
}

// installPresenceReceiver wires the preload half: apply every pushed state,
// and pull the current one once so the initial stamp doesn't wait for the
// next transition. A failed initial pull leaves the attribute absent — the
// SPA treats that as "no shell verdict" and its web heuristics govern.
export function installPresenceReceiver(
  doc: PresenceDoc,
  subscribe: (cb: (state: string) => void) => void,
  queryInitial: () => Promise<string>,
): void {
  subscribe((state) => applyPresenceState(doc, state));
  queryInitial()
    .then((state) => applyPresenceState(doc, state))
    .catch(() => {
      // No initial verdict — the page's own heuristics apply until the
      // first pushed transition lands.
    });
}
