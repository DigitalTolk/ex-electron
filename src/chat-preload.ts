import { ipcRenderer, webFrame } from 'electron';
import { NOTIFY_OVERRIDE_SOURCE } from './lib/notify-override';
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

webFrame.insertCSS(CHAT_DRAG_REGION_CSS);
webFrame.insertCSS(CONNECTION_BANNER_CSS);

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
