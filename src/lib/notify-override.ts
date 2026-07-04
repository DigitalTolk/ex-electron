// DOM event the page-side wrapper dispatches when the user clicks a desktop
// notification. The chat preload (isolated world, shared DOM) listens for it
// and asks the main process to raise the window — the SPA's own onclick
// handler calls window.focus(), which a renderer cannot rely on to restore or
// raise a backgrounded BrowserWindow on Windows/Linux.
export const NOTIFICATION_ACTIVATED_EVENT = 'ex:notification-activated';

// Source for the page-side script that strips icon/image/badge from
// notifications opened by the chat host, so the OS falls back to the app icon.
// Also forces silent:true so the OS does not play a sound — the chat already
// plays its own notification audio in-page.
// Kept as a string because it runs in the page's main world via
// webFrame.executeJavaScript from the chat preload.
export const NOTIFY_OVERRIDE_SOURCE = `(() => {
  const Original = window.Notification;
  if (!Original || Original.__exWrapped) return;
  function strip(opts) {
    const o = Object.assign({}, opts || {});
    delete o.icon; delete o.image; delete o.badge;
    o.silent = true;
    return o;
  }
  function Wrapped(title, opts) {
    const n = new Original(title, strip(opts));
    // Signal notification clicks across the world boundary so the preload can
    // have the main process restore/raise the window; the page's own onclick
    // (deep-link navigation) still runs — this is an additional listener.
    if (n && typeof n.addEventListener === 'function') {
      n.addEventListener('click', () => {
        try {
          document.dispatchEvent(new Event('${NOTIFICATION_ACTIVATED_EVENT}'));
        } catch {
          // A torn-down document can't be signalled; the click still ran.
        }
      });
    }
    return n;
  }
  Wrapped.prototype = Original.prototype;
  Wrapped.__exWrapped = true;
  Object.defineProperty(Wrapped, 'permission', { get: () => Original.permission });
  Object.defineProperty(Wrapped, 'maxActions', { get: () => Original.maxActions });
  Wrapped.requestPermission = Original.requestPermission.bind(Original);
  window.Notification = Wrapped;
})();`;
