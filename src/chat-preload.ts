import { ipcRenderer, webFrame } from 'electron';
import { NOTIFICATION_ACTIVATED_EVENT, NOTIFY_OVERRIDE_SOURCE } from './lib/notify-override';
import { DND_BRIDGE_SOURCE, DND_IPC_CHANNEL, installDndAnswerer } from './lib/dnd-bridge';
import { installPresenceReceiver, PRESENCE_IPC_CHANNEL } from './lib/presence-bridge';
import { CHAT_DRAG_REGION_CSS } from './lib/drag-region';
import {
  CONNECTION_BANNER_CSS,
  createConnectionBanner,
  type ConnectionState,
} from './lib/connection';

// Inject the notification-icon stripper into the page's main world. The chat
// host's untrusted JavaScript will see our wrapped Notification constructor
// once page scripts run. We expose nothing back: there is no contextBridge
// surface area on the chat window by design.
webFrame.executeJavaScript(NOTIFY_OVERRIDE_SOURCE).catch((err) => {
  console.error('notification override failed:', err);
});

// Install the SPA's desktop-shell markers + DnD bridge (window.__EX_DESKTOP__
// and window.__EX_DND__) into the page's main world, and answer its queries
// from this isolated world via DOM events — ipcRenderer itself is never
// exposed to the untrusted page. The worst the page can do is read a boolean
// "is the OS on Focus" answer.
webFrame.executeJavaScript(DND_BRIDGE_SOURCE).catch((err) => {
  console.error('dnd bridge failed:', err);
});
installDndAnswerer(document, () => ipcRenderer.invoke(DND_IPC_CHANNEL));

// OS-presence bridge (away-monitor → page): main pushes lock/sleep/idle
// verdicts; we stamp them on <html> and fire a DOM event the SPA listens to
// (its src/lib/desktop-presence.ts). The page sees only a state string —
// ipcRenderer stays in this isolated world.
installPresenceReceiver(
  document,
  (cb) => ipcRenderer.on(PRESENCE_IPC_CHANNEL, (_event, state: string) => cb(state)),
  () => ipcRenderer.invoke(PRESENCE_IPC_CHANNEL),
);

webFrame.insertCSS(CHAT_DRAG_REGION_CSS);
webFrame.insertCSS(CONNECTION_BANNER_CSS);

// A clicked desktop notification must raise the (possibly minimized or
// backgrounded) chat window. The page's SPA calls window.focus(), which a
// renderer can't rely on for that on Windows/Linux — the wrapped Notification
// (see NOTIFY_OVERRIDE_SOURCE) dispatches a DOM event that crosses the world
// boundary, and main restores/focuses the BrowserWindow. Nothing is exposed
// to the page: the worst untrusted code can do is focus the app's own window.
document.addEventListener(NOTIFICATION_ACTIVATED_EVENT, () => {
  ipcRenderer.send('notification:activated');
});

// Connection banner. The main process tracks connection/auth state from signals
// it can see (power resume, page-load failures, HTTP 401/419) and pushes the
// current state here; we also feed the renderer's own online/offline events
// back to main. All of this lives in the preload's isolated world — ipcRenderer
// is never exposed to the untrusted page, so the only thing the page can do is
// (cosmetically) remove our banner node.
function initConnectionBanner(): void {
  const banner = createConnectionBanner(document, {
    onAction: () => ipcRenderer.send('connection:signin'),
  });

  ipcRenderer.on('connection:state', (_event, state: ConnectionState) => {
    banner.setState(state);
  });

  // Mirror the renderer's connectivity to main. navigator.onLine flips on
  // Wi-Fi/cable changes; the main process turns an offline→online transition
  // into a reload so the SPA gets a fresh WebSocket.
  window.addEventListener('online', () => ipcRenderer.send('connection:online'));
  window.addEventListener('offline', () => ipcRenderer.send('connection:offline'));
  if (!navigator.onLine) ipcRenderer.send('connection:offline');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initConnectionBanner, { once: true });
} else {
  initConnectionBanner();
}
