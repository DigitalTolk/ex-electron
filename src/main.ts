import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  ipcMain,
  shell,
  nativeImage,
  nativeTheme,
  session,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import http from 'node:http';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { safeUrl, trimTrailingSlash, isHttpUrl } from './lib/url';
import { parseUnreadCount } from './lib/title';
import { overlayBadgeSvg } from './lib/overlay';
import { AUTH_CALLBACK_HTML } from './lib/auth-callback';

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
let tray: Tray | null = null;
let unreadCount = 0;
let pendingAuth: { server: http.Server; authUrl: string } | null = null;

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
  chatWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'ex',
    icon: appIconPath(),
    backgroundColor: '#0a0a0a',
    // The chat SPA already has its own top bar with empty space on either
    // side, so we drop the native title bar and let the window controls
    // overlay it — Slack/Discord/VS Code pattern. On macOS the traffic
    // lights sit at top-left; on Windows/Linux the min/max/close buttons
    // sit at top-right via titleBarOverlay (Linux requires a CSD-capable
    // compositor like GNOME, otherwise it falls back to no controls).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#0a0a0a',
            symbolColor: '#ffffff',
            height: 40,
          },
        }),
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
      partition: 'persist:ex-chat',
    },
  });

  chatWindow.loadURL(settings.chatUrl);

  chatWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  chatWindow.webContents.on('will-navigate', (event, url) => {
    const target = safeUrl(url);
    if (!target || !settings.chatUrl) return;
    const chatHost = new URL(settings.chatUrl).host;

    // Intercept any in-window jump to the SSO start URL and route it through
    // the system browser using the desktop_code flow instead. SSO providers
    // generally refuse embedded webviews, and this gives the user a real
    // password-manager-friendly login page.
    if (target.host === chatHost && target.pathname === '/auth/oidc/login') {
      event.preventDefault();
      startDesktopAuth().catch((err) => console.error('desktop auth failed:', err));
      return;
    }

    if (target.host !== chatHost) {
      event.preventDefault();
      shell.openExternal(target.toString()).catch(() => {});
    }
  });

  chatWindow.webContents.on('context-menu', (_event, params) => {
    if (!chatWindow) return;
    const items = chatContextMenuItems(params);
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window: chatWindow });
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

  // Recover from renderer failures: a renderer crash or a transient
  // did-fail-load (DNS hiccup, server restart) otherwise leaves a blank
  // window with no recovery. Exponential backoff up to 30s so a hard-down
  // server doesn't pin a CPU core in a reload loop.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadDelayMs = 1000;
  const scheduleReload = (): void => {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      chatWindow?.webContents.reload();
    }, reloadDelayMs);
    reloadDelayMs = Math.min(reloadDelayMs * 2, 30_000);
  };
  chatWindow.webContents.on('did-finish-load', () => {
    reloadDelayMs = 1000;
  });
  chatWindow.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED, fired for user-initiated nav cancels. Subframes
    // failing to load is the chat SPA's problem, not ours.
    if (!isMainFrame || code === -3) return;
    scheduleReload();
  });
  chatWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    scheduleReload();
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
    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }
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

// Right-click menu for the chat window. The chat host is untrusted so we keep
// this minimal: copy a link target if there is one, plus the standard
// edit-role items (cut/copy/paste). Everything routes through Electron's own
// roles so behavior matches the OS.
function chatContextMenuItems(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  if (params.linkURL) {
    items.push({
      label: 'Copy link',
      click: () => clipboard.writeText(params.linkURL),
    });
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
    { role: 'viewMenu' },
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
  const ses = session.fromPartition('persist:ex-chat');
  try {
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'],
    });
  } catch (err) {
    console.error('clearStorageData failed:', err);
  }
  setUnreadCount(0);
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildApplicationMenu());
  createTray();
  if (settings.chatUrl) createChatWindow();
  else createSetupWindow();
});
