// Bridge for the chat SPA's `window.__EX_ATTENTION__` contract (see the ex
// repo's src/types/global.d.ts): when an agent run BLOCKS waiting on the user's
// decision, a banner alone is easy to miss — it can be dismissed, or land while
// the app is behind other windows. The shell answers with the platform's own
// "this app needs you" signal: a bouncing dock icon on macOS, a flashing
// taskbar entry on Windows/Linux. Ordinary messages never do this, which is
// what makes an approval visually distinct at a glance.
//
// Same shared-DOM crossing as the DnD bridge — the chat window exposes NO
// contextBridge surface to the untrusted page:
//
//   page (main world)               preload (isolated world)        main
//   __EX_ATTENTION__() ──request──▶ listener ──ipc send──▶ dock.bounce()/flashFrame()
//
// Fire-and-forget: there is nothing to answer, so unlike the DnD bridge there
// is no reply event or timeout. The worst untrusted page code can do is make
// the app's OWN dock icon bounce.

export const ATTENTION_REQUEST_EVENT = 'ex:attention-request';
export const ATTENTION_IPC_CHANNEL = 'attention:request';

// Page-side source, injected into the main world via webFrame.executeJavaScript
// (kept as a string for that mechanism, like the other bridges).
export const ATTENTION_BRIDGE_SOURCE = `(() => {
  if (window.__EX_ATTENTION__) return;
  window.__EX_ATTENTION__ = () => {
    try {
      document.dispatchEvent(new Event('${ATTENTION_REQUEST_EVENT}'));
    } catch {
      // A page without a live document can't ask for attention; nothing to do.
    }
  };
})();`;

// installAttentionAnswerer wires the preload (isolated-world) half: forward each
// page request to main, which owns the window/dock handles.
export function installAttentionAnswerer(doc: Document, request: () => void): void {
  doc.addEventListener(ATTENTION_REQUEST_EVENT, () => {
    request();
  });
}
