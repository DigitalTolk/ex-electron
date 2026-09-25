import { ipcRenderer, webFrame } from 'electron';
import { NOTIFICATION_ACTIVATED_EVENT, NOTIFY_OVERRIDE_SOURCE } from './lib/notify-override';
import { DND_BRIDGE_SOURCE, DND_IPC_CHANNEL, installDndAnswerer } from './lib/dnd-bridge';
import {
  ATTENTION_BRIDGE_SOURCE,
  ATTENTION_IPC_CHANNEL,
  installAttentionAnswerer,
} from './lib/attention-bridge';
import {
  APPROVAL_BRIDGE_SOURCE,
  APPROVAL_DECIDED_IPC,
  APPROVAL_NOTIFY_IPC,
  installApprovalAnswerer,
  type ApprovalDecision,
} from './lib/approval-bridge';
import {
  RUNNER_BRIDGE_SOURCE,
  RUNNER_TOKEN_IPC_CHANNEL,
  installRunnerTokenListener,
} from './lib/runner-bridge';
import {
  CONNECTOR_SSO_BRIDGE_SOURCE,
  CONNECTOR_SSO_IPC,
  installConnectorSSOAnswerer,
  type ConnectorSSOResult,
} from './lib/connector-sso';
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

// Attention bridge: a blocked agent run asks the OS to flag the app (dock
// bounce / taskbar flash) so an approval is noticeable even behind other
// windows. Same shared-DOM crossing; nothing is exposed to the page.
webFrame.executeJavaScript(ATTENTION_BRIDGE_SOURCE).catch((err) => {
  console.error('attention bridge failed:', err);
});
installAttentionAnswerer(document, () => {
  ipcRenderer.send(ATTENTION_IPC_CHANNEL);
});

// Approval bridge: a blocked gate becomes a NATIVE OS notification with
// Approve / Reject (or choice) buttons; the clicked verdict comes back here
// and is dispatched into the page, which POSTs it with the user's session.
webFrame.executeJavaScript(APPROVAL_BRIDGE_SOURCE).catch((err) => {
  console.error('approval bridge failed:', err);
});
installApprovalAnswerer(
  document,
  (payload) => ipcRenderer.invoke(APPROVAL_NOTIFY_IPC, payload),
  (relay) => ipcRenderer.on(APPROVAL_DECIDED_IPC, (_event, decision: ApprovalDecision) => relay(decision)),
);

// Agent-runner token handoff: the SPA mints the runner-scoped token (it
// holds the interactive session) and hands it to the shell, which runs the
// local agent harness. Same shared-DOM crossing as the DnD bridge.
webFrame.executeJavaScript(RUNNER_BRIDGE_SOURCE).catch((err) => {
  console.error('runner bridge failed:', err);
});
installRunnerTokenListener(document, (token) => {
  ipcRenderer.send(RUNNER_TOKEN_IPC_CHANNEL, token);
});

// Connector one-click SSO: the SPA asks the shell to open a service's own
// sign-in window (the user authenticates with Microsoft there) and resolves
// with the bearer the service mints, captured from its redirect. Same
// shared-DOM crossing; the page only ever sees the token for the connector it
// asked to connect, which it then installs with its own session.
webFrame.executeJavaScript(CONNECTOR_SSO_BRIDGE_SOURCE).catch((err) => {
  console.error('connector sso bridge failed:', err);
});
installConnectorSSOAnswerer(document, (req) => ipcRenderer.invoke(CONNECTOR_SSO_IPC, req) as Promise<ConnectorSSOResult>);

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
