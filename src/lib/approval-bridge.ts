// Bridge for the chat SPA's `window.__EX_APPROVAL_NOTIFY__` contract (see the
// ex repo's src/types/global.d.ts): when an agent run BLOCKS on the user's
// decision, the SPA hands the gate to the shell, which raises a NATIVE OS
// notification carrying Approve / Reject (or the offered choices) as real
// system buttons. The web Notification API cannot render action buttons, so a
// main-process electron.Notification is the only way to let the user decide
// from the notification itself.
//
// Crossing the world boundary: the chat window exposes NO contextBridge
// surface to the untrusted page, so — exactly like the DnD bridge — data
// crosses the isolated↔main boundary as a JSON string stamped on a shared DOM
// attribute, signalled by a PLAIN Event. CustomEvent `detail` is deliberately
// NOT used across that boundary: JS values don't reliably survive it (they
// arrive null), which silently broke the verdict round-trip. Only the final
// main-world→SPA hop (page source → NotificationProvider) uses a CustomEvent,
// where detail is same-world and safe.
//
//   page (main world)                 preload (isolated world)         main
//   __EX_APPROVAL_NOTIFY__(p)         stamp attr + Event
//     └ stamp req attr + Event ─────▶ read attr ─ipc invoke──▶ new Notification({actions})
//   'ex:approval-decision'  ◀ re-emit ◀ stamp dec attr + Event ◀─ipc send─ button click
//     (CustomEvent, same world)

export const APPROVAL_REQUEST_EVENT = 'ex:approval-notify-request'; // page → isolated (plain Event)
export const APPROVAL_REQUEST_ATTR = 'data-ex-approval-request'; // JSON payload on <html>
export const APPROVAL_DECIDED_EVENT = 'ex:approval-decided'; // isolated → page (plain Event)
export const APPROVAL_DECISION_ATTR = 'data-ex-approval-decision'; // JSON verdict on <html>
export const APPROVAL_DECISION_EVENT = 'ex:approval-decision'; // page source → SPA (CustomEvent, same world)
export const APPROVAL_NOTIFY_IPC = 'approval:notify'; // preload → main
export const APPROVAL_DECIDED_IPC = 'approval:decided'; // main → preload

// The gate the shell must render buttons for.
export interface ApprovalNotifyPayload {
  approvalID: string;
  runID: string;
  title: string;
  body: string;
  // Present ⇒ a question: each choice becomes a button (approve with it).
  // Absent ⇒ a permission gate: Approve / Reject.
  choices?: string[];
}

// The verdict a clicked system button carries back to the page.
export interface ApprovalDecision {
  approvalID: string;
  runID: string;
  approve: boolean;
  choice?: string;
}

// Page-side source, injected into the main world via webFrame.executeJavaScript
// (kept as a string for that mechanism, like the other bridges). Installs
// __EX_APPROVAL_NOTIFY__ (feature-detected by the SPA) and re-emits the shell's
// verdict as a same-world CustomEvent the NotificationProvider listens for.
export const APPROVAL_BRIDGE_SOURCE = `(() => {
  if (window.__EX_APPROVAL_NOTIFY__) return;
  window.__EX_APPROVAL_NOTIFY__ = (payload) => {
    try {
      document.documentElement.setAttribute('${APPROVAL_REQUEST_ATTR}', JSON.stringify(payload));
      document.dispatchEvent(new Event('${APPROVAL_REQUEST_EVENT}'));
    } catch {
      // A page without a live document can't raise a gate; nothing to do.
    }
  };
  document.addEventListener('${APPROVAL_DECIDED_EVENT}', () => {
    try {
      const raw = document.documentElement.getAttribute('${APPROVAL_DECISION_ATTR}');
      if (!raw) return;
      document.dispatchEvent(new CustomEvent('${APPROVAL_DECISION_EVENT}', { detail: JSON.parse(raw) }));
    } catch {
      // Malformed/torn-down: drop it — the on-screen card and the event stream still settle the gate.
    }
  });
})();`;

// installApprovalAnswerer wires the preload (isolated-world) half: on each page
// request read the stamped payload and forward it to main (which owns the
// native Notification), and stamp+signal each verdict main sends back so the
// page source can re-emit it.
export function installApprovalAnswerer(
  doc: Document,
  notify: (payload: ApprovalNotifyPayload) => void,
  onDecided: (relay: (decision: ApprovalDecision) => void) => void,
): void {
  doc.addEventListener(APPROVAL_REQUEST_EVENT, () => {
    const raw = doc.documentElement.getAttribute(APPROVAL_REQUEST_ATTR);
    if (!raw) return;
    try {
      notify(JSON.parse(raw) as ApprovalNotifyPayload);
    } catch {
      // Malformed payload — ignore; the SPA card is still the fallback.
    }
  });
  onDecided((decision) => {
    try {
      doc.documentElement.setAttribute(APPROVAL_DECISION_ATTR, JSON.stringify(decision));
      doc.dispatchEvent(new Event(APPROVAL_DECIDED_EVENT));
    } catch {
      // The page went away between showing the notification and the click.
    }
  });
}
