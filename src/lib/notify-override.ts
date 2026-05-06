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
    return new Original(title, strip(opts));
  }
  Wrapped.prototype = Original.prototype;
  Wrapped.__exWrapped = true;
  Object.defineProperty(Wrapped, 'permission', { get: () => Original.permission });
  Object.defineProperty(Wrapped, 'maxActions', { get: () => Original.maxActions });
  Wrapped.requestPermission = Original.requestPermission.bind(Original);
  window.Notification = Wrapped;
})();`;
