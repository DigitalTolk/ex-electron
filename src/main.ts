import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  nativeImage,
  session,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import http from 'node:http';
import { URL } from 'node:url';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { safeUrl, trimTrailingSlash, isHttpUrl } from './lib/url';
import { parseUnreadCount } from './lib/title';
import { overlayBadgeSvg } from './lib/overlay';

let isQuitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.lifeofguenter.ex.desktop');
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
  : path.join(__dirname, '..', 'build');

function appIconPath(): string {
  if (process.platform === 'win32') return path.join(ICONS_DIR, 'icon.ico');
  return path.join(ICONS_DIR, 'icon.png');
}

function trayIconPath(): string {
  if (process.platform === 'darwin') return path.join(ICONS_DIR, 'trayTemplate.png');
  return path.join(ICONS_DIR, 'tray.png');
}

function createSetupWindow(): void {
  setupWindow = new BrowserWindow({
    width: 440,
    height: 360,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Ex — Connect',
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
    title: 'Ex',
    icon: appIconPath(),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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

  chatWindow.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    setUnreadCount(parseUnreadCount(title));
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

  const cleanup = (): void => {
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
    res.end(`<!doctype html><meta charset="utf-8"><title>Signed in</title>
<style>body{font:15px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
  display:grid;place-items:center;height:100vh;margin:0;color:#1f2937}</style>
<p>Signed in. You can close this tab and return to Ex.</p>`);
    cleanup();

    if (chatWindow && settings.chatUrl) {
      const completeUrl = `${trimTrailingSlash(settings.chatUrl)}/auth/desktop/complete?code=${encodeURIComponent(code)}`;
      chatWindow.loadURL(completeUrl);
      chatWindow.show();
      chatWindow.focus();
    }
  });

  setTimeout(() => cleanup(), 10 * 60 * 1000).unref();

  shell.openExternal(authUrl).catch((err) => {
    console.error('shell.openExternal failed:', err);
    cleanup();
  });
}

// ---- tray + unread badge ---------------------------------------------------

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Ex', click: () => showOrCreateChat() },
    {
      label: 'Sign out',
      enabled: !!settings.chatUrl,
      click: () => {
        signOut().catch((err) => console.error('signOut failed:', err));
      },
    },
    { type: 'separator' },
    {
      label: 'Change chat URL…',
      click: () => changeChatUrl(),
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

function refreshTray(): void {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(unreadCount > 0 ? `Ex — ${unreadCount} unread` : 'Ex');
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath());
  if (process.platform === 'darwin') image.setTemplateImage(true);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.on('click', () => showOrCreateChat());
  refreshTray();
}

function setUnreadCount(n: number): void {
  unreadCount = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  app.setBadgeCount(unreadCount);
  refreshTray();
  if (process.platform === 'win32' && chatWindow) {
    const overlay = buildOverlayIcon(unreadCount);
    chatWindow.setOverlayIcon(overlay, unreadCount > 0 ? `${unreadCount} unread` : '');
  }
}

function buildOverlayIcon(count: number): NativeImage | null {
  const svg = overlayBadgeSvg(count);
  if (!svg) return null;
  return nativeImage.createFromBuffer(Buffer.from(svg));
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
  createTray();
  if (settings.chatUrl) createChatWindow();
  else createSetupWindow();
});
