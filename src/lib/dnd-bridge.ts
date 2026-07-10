// Bridge for the chat SPA's `window.__EX_DND__` contract (see the ex repo's
// src/types/global.d.ts): before playing its custom notification ping, the
// SPA asks whether the OS is on Do Not Disturb / Focus so the ping can stay
// quiet — Slack/Mattermost behavior. The chat window deliberately exposes NO
// contextBridge surface to the untrusted page, so the bridge crosses the
// world boundary with shared-DOM primitives only:
//
//   page (main world)          preload (isolated world)             main
//   __EX_DND__() ──query evt──▶ listener ──ipc invoke 'dnd:state'──▶ getDndState()
//   promise ◀──answer evt────── stamps data-ex-dnd on <html> ◀───────┘
//
// The page-side promise resolves by reading the data-ex-dnd attribute when
// the answer event lands. Plain Events + an attribute are used (never
// CustomEvent detail) because JS values don't reliably cross the isolated-
// world boundary; the shared DOM does. A missing or late answer resolves
// with the last stamped state (initially "not DnD") — fail toward the
// audible ping, matching the SPA's own failure direction.

export const DND_QUERY_EVENT = 'ex:dnd-query';
export const DND_ANSWER_EVENT = 'ex:dnd-answer';
export const DND_STATE_ATTR = 'data-ex-dnd';
export const DND_ANSWER_TIMEOUT_MS = 1500;
export const DND_IPC_CHANNEL = 'dnd:state';

// Page-side source, injected into the main world via webFrame.executeJavaScript
// (same mechanism as NOTIFY_OVERRIDE_SOURCE — kept as a string for that).
export const DND_BRIDGE_SOURCE = `(() => {
  if (window.__EX_DND__) return;
  // Generic desktop-shell marker the SPA keys off (device kind, the macOS
  // traffic-light inset, notification icon handling). Set here because this
  // injected source is the shell's page-world touchpoint.
  window.__EX_DESKTOP__ = true;
  window.__EX_DND__ = () => new Promise((resolve) => {
    let done = false;
    const answer = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('${DND_ANSWER_EVENT}', answer);
      resolve(document.documentElement.getAttribute('${DND_STATE_ATTR}') === '1');
    };
    const timer = setTimeout(answer, ${DND_ANSWER_TIMEOUT_MS});
    document.addEventListener('${DND_ANSWER_EVENT}', answer);
    document.dispatchEvent(new Event('${DND_QUERY_EVENT}'));
  });
})();`;

// installDndAnswerer wires the preload (isolated-world) half: on each page
// query, ask the main process for the OS state, stamp it on <html>, and fire
// the answer event. A failed query keeps the last stamped state but still
// answers, so the page never waits out its timeout on a healthy preload.
export function installDndAnswerer(doc: Document, queryState: () => Promise<boolean>): void {
  doc.addEventListener(DND_QUERY_EVENT, () => {
    queryState()
      .then((dnd) => {
        doc.documentElement.setAttribute(DND_STATE_ATTR, dnd ? '1' : '0');
      })
      .catch(() => {
        // Keep the last stamped state — stale beats never.
      })
      .finally(() => {
        doc.dispatchEvent(new Event(DND_ANSWER_EVENT));
      });
  });
}
