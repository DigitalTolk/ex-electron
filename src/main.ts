import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  shell,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { safeUrl, trimTrailingSlash, isHttpUrl, isSameHost } from './lib/url';
import { imageFilename, uniqueDownloadPath } from './lib/download';
import { parseUnreadCount } from './lib/title';
import { overlayBadgeSvg } from './lib/overlay';
import { AUTH_CALLBACK_HTML } from './lib/auth-callback';
import { authStateForXhr, type ConnectionState } from './lib/connection';
import { getDndState } from './lib/dnd-state';
import { DND_IPC_CHANNEL } from './lib/dnd-bridge';
import { AwayMonitor } from './lib/away-monitor';
import { PRESENCE_IPC_CHANNEL } from './lib/presence-bridge';

let isQuitting = false;

// Drives the macOS application menu labels: "About ex", "Hide ex", "Quit ex".
// Electron's default menu reads from app.getName(); this also covers `electron .`
// in dev where there's no .app bundle to fall back to.
app.setName('ex');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.digitaltolk.ex.electron');
}

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const settings: Settings = loadSettings(SETTINGS_FILE);
let setupWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
// OS-presence watcher (lock/sleep/idle → the SPA stops acking notifications
// so its mobile fallback fires). Constructed in whenReady — powerMonitor's
// methods are unusable before the app's ready event.
let awayMonitor: AwayMonitor | null = null;
let tray: Tray | null = null;
let unreadCount = 0;
let pendingAuth: { server: http.Server; authUrl: string } | null = null;

const CHAT_PARTITION = 'persist:ex-chat';

// Private isolated world for our context-menu image probe. Distinct from the
// preload's world so we get untampered copies of the DOM APIs; any unused id
// works since all worlds in a frame share the same document.
const IMAGE_PROBE_WORLD_ID = 1010;

// ---- connection / reconnect state ------------------------------------------
//
// The shell owns no SPA code, so it can't see the chat app's own WebSocket.
// Instead we infer connection health from signals the main process *can* see —
// page-load failures, renderer crashes, OS power resume, renderer online/
// offline events, and HTTP 401/419 from the chat API — and drive a banner the
// chat preload injects over the SPA. The only reliable reconnect a thin shell
// has is to reload the chat window; we do that with exponential backoff so a
// hard-down server doesn't pin a CPU core in a reload loop.
let connectionState: ConnectionState = 'connected';
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let reloadDelayMs = 1000;
// Consecutive auth-expiry (401/419) responses seen on the chat API. The banner
// only fires once this crosses AUTH_EXPIRY_THRESHOLD; any success resets it.
let consecutiveAuthFailures = 0;

function setConnectionState(next: ConnectionState): void {
  if (next === connectionState) return;
  connectionState = next;
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('connection:state', next);
  }
}

// The transient states a successful load can clear and a connectivity-return can
// kick a reconnect from — i.e. everything except 'connected' (nothing to do) and
// 'auth-expired' (needs a sign-in, not a reload).
function isReconnectableState(state: ConnectionState): boolean {
  return state === 'offline' || state === 'reconnecting';
}

function clearReloadTimer(): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

// Reset the reconnect machinery to its idle baseline: no pending reload, backoff
// rewound, banner cleared. Used when a window is (re)created or torn down.
function resetReconnectState(): void {
  clearReloadTimer();
  reloadDelayMs = 1000;
  connectionState = 'connected';
  consecutiveAuthFailures = 0;
}

function scheduleReload(): void {
  if (reloadTimer || !chatWindow) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    chatWindow?.webContents.reload();
  }, reloadDelayMs);
  reloadDelayMs = Math.min(reloadDelayMs * 2, 30_000);
}

// A renderer crash or main-frame load failure: show "Reconnecting…" and retry
// with backoff.
function recoverFromFailure(): void {
  setConnectionState('reconnecting');
  scheduleReload();
}

// Force an immediate reconnect, bypassing the backoff timer — used when we have
// a strong signal that the socket is stale (power resume) or that connectivity
// just returned. Reloading is destructive to unsent drafts, so it's reserved
// for these high-confidence cases rather than every transient blip.
function reconnectNow(): void {
  if (!chatWindow) return;
  clearReloadTimer();
  reloadDelayMs = 1000;
  setConnectionState('reconnecting');
  chatWindow.webContents.reload();
}

// Watch the chat session's API responses to track auth state. Repeated 401/419s
// on XHR/fetch mean the saved session is dead even though the page is still
// "loaded", which is exactly the case the old load-failure recovery missed. We
// surface it as a banner with a Sign in button rather than silently launching
// the SSO browser, so the re-auth is never a surprise. Conversely, a later 2xx
// proves the session recovered, so we clear the banner — otherwise a stray
// 401/419 would latch it forever. authStateForXhr owns both decisions plus the
// consecutive-failure threshold (so a lone blip never raises the banner) and
// ignoring the /auth/* login flow; we just thread the failure counter through.
//
// onCompleted holds a single listener, so re-registering here (e.g. after a
// server change) just rebinds the filter to the current origin.
function attachAuthWatch(): void {
  if (!settings.chatUrl) return;
  const origin = new URL(settings.chatUrl).origin;
  session
    .fromPartition(CHAT_PARTITION)
    .webRequest.onCompleted({ urls: [`${origin}/*`] }, (details) => {
      // Electron reports both XMLHttpRequest and fetch() as 'xhr'; that's the
      // SPA's API traffic. Ignore navigations, assets, and the WebSocket.
      if (details.resourceType !== 'xhr') return;
      const reqUrl = safeUrl(details.url);
      if (!reqUrl) return;
      const outcome = authStateForXhr(
        connectionState,
        consecutiveAuthFailures,
        details.statusCode,
        reqUrl.pathname,
      );
      consecutiveAuthFailures = outcome.failures;
      if (outcome.state) setConnectionState(outcome.state);
    });
}

const ICONS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'icons')
  : path.join(__dirname, '..', 'prebuilt');

// macOS reads the dock/Finder icon from the app bundle (CFBundleIconName →
// Assets.car for dynamic theming, with CFBundleIconFile → icon.icns as the
// legacy fallback). We don't override it at runtime — that would defeat the
// system's appearance-aware rendering.
function appIconPath(): string {
  if (process.platform === 'win32') return path.join(ICONS_DIR, 'icon.ico');
  return path.join(ICONS_DIR, 'icon.png');
}

interface TrayImage {
  path: string;
  template: boolean;
}

// Tray icon decision tree:
//   no unread, macOS  → black glyph as a template image; menu bar re-tints
//   no unread, others → same black glyph but as a regular image
//   unread,  macOS    → glyph + pink dot; appearance-aware (light/dark) so
//                       we can't use a template here. We swap the variant on
//                       nativeTheme changes instead.
//   unread, others    → glyph + pink dot; system tray background is stable
//                       so a single colour variant is enough
function trayImageFor(unread: number): TrayImage {
  const dir = ICONS_DIR;
  const isDarwin = process.platform === 'darwin';
  if (unread === 0) {
    if (isDarwin) return { path: path.join(dir, 'trayTemplate.png'), template: true };
    return { path: path.join(dir, 'tray.png'), template: false };
  }
  if (isDarwin) {
    const variant = nativeTheme.shouldUseDarkColors ? 'trayBadgedDark.png' : 'trayBadgedLight.png';
    return { path: path.join(dir, variant), template: false };
  }
  return { path: path.join(dir, 'trayBadged.png'), template: false };
}

function createSetupWindow(): void {
  setupWindow = new BrowserWindow({
    width: 640,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'ex — Connect',
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup', 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    if (!chatWindow && !settings.chatUrl) app.quit();
  });
}

function createChatWindow(): void {
  if (!settings.chatUrl) return;
  // Fresh window starts from a clean connection slate.
  resetReconnectState();
  chatWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'ex',
    icon: appIconPath(),
    backgroundColor: '#0a0a0a',
    // On macOS the chat SPA's top search bar has empty space on either side,
    // so we drop the native title bar and let the traffic lights (top-LEFT)
    // overlay it — Slack/Discord/VS Code pattern. On Windows/Linux the caption
    // buttons can't move off the right, so an overlay there lands them on top of
    // the SPA's right-aligned avatar; we keep the standard native title bar and
    // menu bar on those platforms instead, even though it doesn't integrate as
    // cleanly.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Chromium throttles timers in hidden/occluded windows, which kills
      // the chat SPA's WebSocket heartbeat when the dock-hidden window sits
      // idle — the server drops the socket, inbound messages stop, and no
      // Notification() fires. Keep the renderer running at full rate so
      // background notifications and reconnects work.
      backgroundThrottling: false,
      partition: CHAT_PARTITION,
    },
  });

  chatWindow.loadURL(settings.chatUrl);

  chatWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = safeUrl(url);
    // Same-host links (a channel or message permalink shared in chat, often
    // rendered as target="_blank") belong in the app, not a browser tab — load
    // them in the existing window so the SPA routes to the message. Everything
    // else opens in the system browser.
    if (target && settings.chatUrl && isSameHost(target, settings.chatUrl)) {
      chatWindow?.loadURL(url).catch(() => {});
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  chatWindow.webContents.on('will-navigate', (event, url) => {
    const target = safeUrl(url);
    if (!target || !settings.chatUrl) return;
    const sameHost = isSameHost(target, settings.chatUrl);

    // Intercept any in-window jump to the SSO start URL and route it through
    // the system browser using the desktop_code flow instead. SSO providers
    // generally refuse embedded webviews, and this gives the user a real
    // password-manager-friendly login page.
    if (sameHost && target.pathname === '/auth/oidc/login') {
      event.preventDefault();
      startDesktopAuth().catch((err) => console.error('desktop auth failed:', err));
      return;
    }

    if (!sameHost) {
      event.preventDefault();
      shell.openExternal(target.toString()).catch(() => {});
    }
  });

  chatWindow.webContents.on('context-menu', (_event, params) => {
    void showChatContextMenu(params);
  });

  chatWindow.webContents.on('page-title-updated', (event, title) => {
    // The chat SPA writes "(N) channel · ex" into its <title>. We pull the
    // unread count out for the dock badge and tray, then explicitly pin our
    // own title so the OS chrome never shows the (N) prefix. The
    // getTitle() guard makes the setTitle a no-op after the first call,
    // because preventDefault() means Electron doesn't apply the SPA's
    // title and ours stays. Kept as a guard against a future Electron
    // change to that behaviour.
    event.preventDefault();
    setUnreadCount(parseUnreadCount(title));
    if (chatWindow && chatWindow.getTitle() !== 'ex') chatWindow.setTitle('ex');
  });

  attachAuthWatch();

  // Recover from renderer failures: a renderer crash or a transient
  // did-fail-load (DNS hiccup, server restart) otherwise leaves a blank
  // window with no recovery. The reconnect helpers (module scope) handle the
  // exponential backoff; here we just map each event onto a state + a retry.
  chatWindow.webContents.on('did-finish-load', () => {
    reloadDelayMs = 1000;
    // A successful load clears any transient connectivity banner. Leave an
    // auth-expired banner alone — only a fresh, authenticated session (which
    // we can't confirm from here) should clear it, and the webRequest watcher
    // will re-flag it on the next 401 if it's still expired.
    if (isReconnectableState(connectionState)) setConnectionState('connected');
  });
  chatWindow.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED, fired for user-initiated nav cancels. Subframes
    // failing to load is the chat SPA's problem, not ours.
    if (!isMainFrame || code === -3) return;
    recoverFromFailure();
  });
  chatWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    recoverFromFailure();
  });

  chatWindow.on('close', (event) => {
    // On macOS hide-to-tray; on Linux/Windows actually quit. Tray menu has
    // explicit Quit and the dock right-click "Quit" calls app.quit() which
    // sets `isQuitting` so we know to let the close happen.
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      chatWindow?.hide();
    }
  });

  chatWindow.on('closed', () => {
    resetReconnectState();
    chatWindow = null;
  });
}

function showOrCreateChat(): void {
  if (chatWindow) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    return;
  }
  createChatWindow();
}

// ---- desktop_code OAuth flow ----------------------------------------------
//
// 1. Spin up an HTTP listener on a random localhost port.
// 2. shell.openExternal(`<chat>/auth/oidc/login?redirect_to=http://localhost:<port>/cb`).
// 3. The server's OIDC callback redirects the user's browser back to our
//    listener with `?desktop_code=<code>`.
// 4. We respond with a tiny "you can close this tab" page, tear the listener
//    down, and navigate the chat window to `/auth/desktop/complete?code=<code>`.
//    That sets the persistent refresh_token cookie inside our Electron session
//    and redirects the SPA into a logged-in state.
async function startDesktopAuth(): Promise<void> {
  if (!settings.chatUrl) return;
  if (pendingAuth) {
    shell.openExternal(pendingAuth.authUrl).catch(() => {});
    return;
  }

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to bind localhost listener');
  }
  const port = address.port;
  const redirectTo = `http://localhost:${port}/cb`;
  const authUrl = `${trimTrailingSlash(settings.chatUrl)}/auth/oidc/login?redirect_to=${encodeURIComponent(redirectTo)}`;

  pendingAuth = { server, authUrl };

  let closed = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (pendingAuth?.server === server) pendingAuth = null;
    server.close();
  };

  server.on('request', (req, res) => {
    const reqUrl = safeUrl(`http://localhost:${port}${req.url ?? '/'}`);
    const code = reqUrl?.searchParams.get('desktop_code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Missing desktop_code.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(AUTH_CALLBACK_HTML);
    cleanup();

    if (chatWindow && settings.chatUrl) {
      const completeUrl = `${trimTrailingSlash(settings.chatUrl)}/auth/desktop/complete?code=${encodeURIComponent(code)}`;
      // Drop the "session expired" banner while we complete sign-in; a
      // successful load flips it back to connected, a later 401 re-flags it.
      setConnectionState('reconnecting');
      chatWindow.loadURL(completeUrl);
      chatWindow.show();
      chatWindow.focus();
    }
  });

  timeoutHandle = setTimeout(() => cleanup(), 10 * 60 * 1000);
  timeoutHandle.unref();

  shell.openExternal(authUrl).catch((err) => {
    console.error('shell.openExternal failed:', err);
    cleanup();
  });
}

// ---- tray + unread badge ---------------------------------------------------

// Build and show the chat window's right-click menu. Electron's context-menu
// hit-test only flags an image when the cursor actually lands on a hit-testable
// one, so images the page renders pointer-events:none — notably the lightbox's
// full-size picture, which sits under a gesture overlay — arrive here with
// hasImageContents:false and no srcURL. When that happens, ask the renderer to
// find the image itself before building the menu.
async function showChatContextMenu(params: ContextMenuParams): Promise<void> {
  const win = chatWindow;
  if (!win || win.isDestroyed()) return;

  let imageUrl: string | null = params.hasImageContents ? params.srcURL : null;
  if (!imageUrl && !params.isEditable) {
    imageUrl = await resolveImageAtPoint(win, params.x, params.y);
    if (win.isDestroyed()) return;
  }

  const items = chatContextMenuItems(params, imageUrl);
  if (items.length === 0) return;
  Menu.buildFromTemplate(items).popup({ window: win });
}

// Right-click menu for the chat window. The chat host is untrusted so we keep
// this minimal: copy a link target if there is one, image save/copy actions on
// any image, plus the standard edit-role items (cut/copy/paste). Everything
// else routes through Electron's own roles so behavior matches the OS. `imageUrl`
// is the image under the cursor (params.srcURL, or one the renderer resolved for
// us when the hit-test missed it), or null when there is no image.
function chatContextMenuItems(
  params: ContextMenuParams,
  imageUrl: string | null,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.linkURL) {
    items.push({
      label: 'Copy link',
      click: () => clipboard.writeText(params.linkURL),
    });
  }

  // Images — including the full-size ones in the lightbox — are served from
  // authenticated URLs, so previously the only way to get one out was to open
  // the attachment and use the SPA's download button. Offer save/copy directly.
  // Save/Copy fetch through the chat session so its cookies authorize the
  // request.
  if (imageUrl) {
    const url = imageUrl;
    if (items.length > 0) items.push({ type: 'separator' });
    const src = safeUrl(url);
    const canFetch = (!!src && isHttpUrl(src)) || url.startsWith('data:');
    if (canFetch) {
      items.push(
        { label: 'Save Image', click: () => void saveImage(url, false) },
        { label: 'Save Image As…', click: () => void saveImage(url, true) },
      );
    }
    // Copy: when the click actually landed on the image, copy the decoded
    // bitmap at that point — it's cheap and also covers blob: sources. When the
    // image was resolved out from under a pointer-events:none overlay (the
    // lightbox), the hit-test can't see it, so fetch the bytes and put them on
    // the clipboard ourselves instead.
    if (params.hasImageContents) {
      const { x, y } = params;
      items.push({ label: 'Copy Image', click: () => chatWindow?.webContents.copyImageAt(x, y) });
    } else if (canFetch) {
      items.push({ label: 'Copy Image', click: () => void copyImage(url) });
    }
  }

  if (params.isEditable) {
    if (items.length > 0) items.push({ type: 'separator' });
    if (params.editFlags.canCut) items.push({ role: 'cut' });
    if (params.editFlags.canCopy) items.push({ role: 'copy' });
    if (params.editFlags.canPaste) items.push({ role: 'paste' });
    if (params.editFlags.canSelectAll) items.push({ role: 'selectAll' });
  } else if (params.selectionText && params.selectionText.length > 0) {
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ role: 'copy' });
  }

  return items;
}

// Find the image under the cursor when Electron's hit-test reported none. The
// lightbox paints its picture with pointer-events:none beneath a gesture
// overlay, so neither the context-menu hit-test nor copyImageAt(x,y) can see
// it. We run in a private isolated world (own copies of the DOM APIs, so the
// untrusted page can't tamper with the result) and look first for any <img>
// under the point, then for the largest <img> whose box merely *contains* the
// point — that catches the pointer-events:none case. The URL is still validated
// against safeUrl/isHttpUrl before anything is fetched.
async function resolveImageAtPoint(
  win: BrowserWindow,
  x: number,
  y: number,
): Promise<string | null> {
  const code = `(() => {
    const x = ${x}, y = ${y};
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.tagName === 'IMG') {
        const s = el.currentSrc || el.src;
        if (s) return s;
      }
    }
    let best = null, bestArea = -1;
    for (const img of document.images) {
      const r = img.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = img; }
    }
    return best ? (best.currentSrc || best.src) : null;
  })()`;
  try {
    const result: unknown = await win.webContents.executeJavaScriptInIsolatedWorld(
      IMAGE_PROBE_WORLD_ID,
      [{ code }],
    );
    return typeof result === 'string' && result ? result : null;
  } catch (err) {
    console.error('image probe failed:', err);
    return null;
  }
}

// Fetch image bytes through the chat session so the request carries the
// session's cookies (chat images sit behind auth). blob: URLs can't be reached
// from the main process and are filtered out before we get here.
async function fetchChatImage(
  rawUrl: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await session.fromPartition(CHAT_PARTITION).fetch(rawUrl);
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? '',
    };
  } catch (err) {
    console.error('image fetch failed:', err);
    return null;
  }
}

// Save an image from the chat window to disk. We fetch (rather than
// downloadURL()) so the request is authenticated and so we never disturb the
// SPA's own downloads with a global will-download handler. `saveAs` shows the
// native save dialog; otherwise it drops into Downloads with a non-colliding
// name.
async function saveImage(rawUrl: string, saveAs: boolean): Promise<void> {
  const win = chatWindow;
  if (!win || win.isDestroyed() || !rawUrl) return;

  const image = await fetchChatImage(rawUrl);
  if (!image || win.isDestroyed()) return;

  const downloads = app.getPath('downloads');
  const filename = imageFilename(rawUrl, image.contentType);

  let target: string;
  if (saveAs) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(downloads, filename),
    });
    if (result.canceled || !result.filePath) return;
    target = result.filePath;
  } else {
    target = uniqueDownloadPath(downloads, filename, fs.existsSync);
  }

  try {
    await fs.promises.writeFile(target, image.buffer);
  } catch (err) {
    console.error('image save failed:', err);
  }
}

// Copy a lightbox (pointer-events:none) image to the clipboard. copyImageAt
// can't reach it because the hit-test misses it, so we fetch the bytes and
// decode them ourselves. Normal images use copyImageAt instead (see the menu).
async function copyImage(rawUrl: string): Promise<void> {
  const image = await fetchChatImage(rawUrl);
  if (!image) return;
  const bitmap = nativeImage.createFromBuffer(image.buffer);
  if (bitmap.isEmpty()) {
    console.error('copy image: could not decode', rawUrl);
    return;
  }
  clipboard.writeImage(bitmap);
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open ex', click: () => showOrCreateChat() },
    {
      label: 'Sign out',
      enabled: !!settings.chatUrl,
      click: () => {
        signOut().catch((err) => console.error('signOut failed:', err));
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

// Application menu (macOS top menu bar; menu bar inside the window on Linux/
// Windows). "Change Server…" lives here so it's discoverable without going
// through the tray. Everything else is delegated to Electron's stock roles
// to match the OS conventions.
function buildApplicationMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [];
  const changeServer: MenuItemConstructorOptions = {
    label: 'Change Server…',
    click: () => changeChatUrl(),
  };

  if (process.platform === 'darwin') {
    template.push({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        changeServer,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  } else {
    template.push({
      label: '&File',
      submenu: [changeServer, { type: 'separator' }, { role: 'quit' }],
    });
  }

  template.push(
    { role: 'editMenu' },
    // Custom View menu mirrors the stock `viewMenu` role minus the zoom items
    // (Actual Size / Zoom In / Zoom Out), which we don't want exposed.
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  );
  return Menu.buildFromTemplate(template);
}

// Cache the current tray state so we only mutate NSStatusItem when something
// actually changed. The chat SPA updates its title constantly (typing
// indicators, channel switches, unread bumps) and unconditional churn on the
// status bar has been observed to interact badly with macOS focus tracking.
let lastTrayImagePath: string | null = null;
let lastTrayTooltip: string | null = null;
let lastTrayMenuKey: string | null = null;
// macOS reloads the tray icon on every nativeTheme update (light/dark
// swap); cache the decoded NativeImage so we hit the disk at most once
// per variant for the life of the process.
const trayImageCache = new Map<string, NativeImage>();

function loadTrayImage(imgPath: string, template: boolean): NativeImage {
  const cached = trayImageCache.get(imgPath);
  if (cached) return cached;
  const image = nativeImage.createFromPath(imgPath);
  if (template) image.setTemplateImage(true);
  const final = image.isEmpty() ? nativeImage.createEmpty() : image;
  trayImageCache.set(imgPath, final);
  return final;
}

function refreshTrayImage(): void {
  if (!tray) return;
  const { path: imgPath, template } = trayImageFor(unreadCount);
  if (imgPath === lastTrayImagePath) return;
  tray.setImage(loadTrayImage(imgPath, template));
  lastTrayImagePath = imgPath;
}

function refreshTray(): void {
  if (!tray) return;
  refreshTrayImage();
  const tooltip = unreadCount > 0 ? `ex — ${unreadCount} unread` : 'ex';
  if (tooltip !== lastTrayTooltip) {
    tray.setToolTip(tooltip);
    lastTrayTooltip = tooltip;
  }
  // Menu only depends on whether Sign Out is enabled (i.e. whether a chat URL
  // is configured) — it doesn't render the unread count. Skip rebuilding it
  // for every keystroke-driven title bump.
  const menuKey = settings.chatUrl ? 'connected' : 'setup';
  if (menuKey !== lastTrayMenuKey) {
    tray.setContextMenu(buildTrayMenu());
    lastTrayMenuKey = menuKey;
  }
}

function createTray(): void {
  const { path: imgPath, template } = trayImageFor(0);
  tray = new Tray(loadTrayImage(imgPath, template));
  lastTrayImagePath = imgPath;
  tray.on('click', () => showOrCreateChat());
  refreshTray();
  // Re-render when the user toggles dark mode, since the badged variants are
  // appearance-specific (the badge dot is non-template so we can't auto-tint).
  nativeTheme.on('updated', refreshTrayImage);
}

function setUnreadCount(n: number): void {
  const next = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (next === unreadCount) return;
  unreadCount = next;
  app.setBadgeCount(unreadCount);
  refreshTray();
  if (process.platform === 'win32' && chatWindow) {
    const overlay = buildOverlayIcon(unreadCount);
    chatWindow.setOverlayIcon(overlay, unreadCount > 0 ? `${unreadCount} unread` : '');
  }
}

// Counts > 99 all render as "99+", so cap the cache key. Each entry is a
// tiny SVG NativeImage, so the cache is bounded and cheap.
const overlayIconCache = new Map<number, NativeImage | null>();

function buildOverlayIcon(count: number): NativeImage | null {
  const key = count > 99 ? 100 : count;
  if (overlayIconCache.has(key)) return overlayIconCache.get(key) ?? null;
  const svg = overlayBadgeSvg(count);
  const image = svg ? nativeImage.createFromBuffer(Buffer.from(svg)) : null;
  overlayIconCache.set(key, image);
  return image;
}

// ---- session / sign-out ----------------------------------------------------

async function signOut(): Promise<void> {
  if (!settings.chatUrl) return;
  const ses = session.fromPartition(CHAT_PARTITION);
  try {
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    });
  } catch (err) {
    console.error('clearStorageData failed:', err);
  }
  setUnreadCount(0);
  // A deliberate sign-out isn't an error state — drop any banner and let the
  // SPA render its own login screen.
  setConnectionState('connected');
  if (chatWindow) chatWindow.loadURL(settings.chatUrl);
}

function changeChatUrl(): void {
  settings.chatUrl = '';
  saveSettings(SETTINGS_FILE, settings);
  if (chatWindow) {
    chatWindow.destroy();
    chatWindow = null;
  }
  if (!setupWindow) createSetupWindow();
  refreshTray();
}

// ---- IPC + lifecycle -------------------------------------------------------

ipcMain.handle('settings:saveChatUrl', (_event, url: unknown): boolean => {
  if (typeof url !== 'string' || !url) throw new Error('invalid url');
  const parsed = safeUrl(url);
  if (!parsed || !isHttpUrl(parsed)) throw new Error('invalid url');
  settings.chatUrl = trimTrailingSlash(parsed.origin);
  saveSettings(SETTINGS_FILE, settings);
  if (setupWindow) setupWindow.close();
  createChatWindow();
  refreshTray();
  return true;
});

// Connection signals from the chat preload's isolated world. Guard on the
// sender so only the chat window can drive reconnect/sign-in — these channels
// are never exposed to the untrusted page, but the guard keeps the setup window
// (or a stray renderer) from triggering them too.
function fromChatWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!chatWindow && !chatWindow.isDestroyed() && event.sender === chatWindow.webContents;
}

// OS Do-Not-Disturb / Focus state for the chat preload's DnD bridge — the SPA
// gates its custom notification ping on this so the ping goes quiet while the
// user is on Focus. Answer false for any other sender: an unexpected renderer
// gets "not DnD", never an error.
ipcMain.handle(DND_IPC_CHANNEL, (event) => {
  if (!fromChatWindow(event)) return false;
  return getDndState();
});

// Current OS-presence verdict for the chat preload's initial pull (pushed
// transitions ride webContents.send — see startAwayMonitor). Any other
// sender gets 'unsupported': the SPA's own web heuristics govern, never an
// error.
ipcMain.handle(PRESENCE_IPC_CHANNEL, (event) => {
  if (!fromChatWindow(event)) return 'unsupported';
  return awayMonitor?.current() ?? 'unsupported';
});

ipcMain.on('connection:offline', (event) => {
  if (!fromChatWindow(event)) return;
  // No point retrying while the OS says there's no network; wait for 'online'.
  clearReloadTimer();
  setConnectionState('offline');
});

ipcMain.on('connection:online', (event) => {
  if (!fromChatWindow(event)) return;
  // Connectivity returned after a loss — force a fresh load so the SPA opens a
  // new WebSocket instead of waiting on its own (often slow) backoff.
  if (isReconnectableState(connectionState)) reconnectNow();
});

ipcMain.on('connection:signin', (event) => {
  if (!fromChatWindow(event)) return;
  startDesktopAuth().catch((err) => console.error('desktop auth failed:', err));
});

ipcMain.on('notification:activated', (event) => {
  if (!fromChatWindow(event) || !chatWindow) return;
  // The user clicked a desktop notification: raise the window. The SPA's own
  // notification onclick handles the deep-link navigation in-page; renderer
  // window.focus() alone can't restore/raise a backgrounded BrowserWindow on
  // Windows/Linux, so main does it.
  if (chatWindow.isMinimized()) chatWindow.restore();
  chatWindow.show();
  chatWindow.focus();
});

app.on('second-instance', () => {
  if (chatWindow) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
  } else if (setupWindow) {
    setupWindow.focus();
  }
});

app.on('activate', () => {
  if (settings.chatUrl) showOrCreateChat();
  else if (!setupWindow) createSetupWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});

// Waking from sleep is the most common way the chat WebSocket dies silently:
// the OS was suspended, the socket timed out server-side, but navigator.onLine
// never flipped so no online/offline event fires and the page still looks
// "loaded". Force a reconnect on resume to recover it.
powerMonitor.on('resume', () => {
  awayMonitor?.handleResume();
  if (chatWindow && connectionState !== 'auth-expired') reconnectNow();
});

// startAwayMonitor wires the OS-presence watcher: 1 Hz idle polling plus
// lock/unlock/suspend transitions, pushed to the chat page over IPC (the
// preload stamps them on <html> for the SPA — see presence-bridge.ts).
// Called from whenReady because powerMonitor's methods only work after the
// ready event. A page mid-load misses pushes harmlessly: the preload pulls
// the current state once on install.
function startAwayMonitor(): void {
  awayMonitor = new AwayMonitor({
    platform: process.platform,
    getSystemIdleTime: () => powerMonitor.getSystemIdleTime(),
  });
  awayMonitor.onChange((state) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send(PRESENCE_IPC_CHANNEL, state);
    }
  });
  powerMonitor.on('lock-screen', () => awayMonitor?.handleLockScreen());
  powerMonitor.on('unlock-screen', () => awayMonitor?.handleUnlockScreen());
  powerMonitor.on('suspend', () => awayMonitor?.handleSuspend());
  awayMonitor.start();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildApplicationMenu());
  createTray();
  startAwayMonitor();
  if (settings.chatUrl) createChatWindow();
  else createSetupWindow();
});
