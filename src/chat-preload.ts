import { webFrame } from 'electron';
import { NOTIFY_OVERRIDE_SOURCE } from './lib/notify-override';
import { CHAT_DRAG_REGION_CSS } from './lib/drag-region';

// Inject the notification-icon stripper into the page's main world. The chat
// host's untrusted JavaScript will see our wrapped Notification constructor
// once page scripts run. We expose nothing back: there is no contextBridge
// surface area on the chat window by design.
webFrame.executeJavaScript(NOTIFY_OVERRIDE_SOURCE).catch((err) => {
  console.error('notification override failed:', err);
});

webFrame.insertCSS(CHAT_DRAG_REGION_CSS);
