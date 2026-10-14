#!/usr/bin/env node
// Renders Mac App Store screenshots from the REAL chat UI.
//
// The desktop app is an Electron shell around the ex web client, so the
// screenshots are the built web client itself, served locally and driven in
// Chromium (Electron's engine) at the 2880x1800 App Store Connect accepts for
// Mac. The API is answered from fixtures instead of a live server, so the
// output is deterministic and carries no real workspace data. The fixtures
// match ex-mobile's scripts/generate-ipad-screenshots.mjs, so the store
// listings tell the same story.
//
//   (cd ../ex && npm run build)
//   npm run build                      # this app's setup screen
//   EX_REPO=../ex node scripts/generate-mas-screenshots.mjs [--force]
//
// The listing's screenshots are maintained in App Store Connect (the release
// lane uploads only the binary), so drag the files from fastlane/screenshots
// into the macOS version page after regenerating them.
// URL is a Node global; the rest run inside the page (addInitScript).
/* global URL, window, navigator, EventTarget */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const EX_REPO = resolve(process.env.EX_REPO ?? '../ex');
// Two bundles: the server's web client (what the chat window loads once a
// server is set) and this app's own setup screen (what a first launch opens on).
const DIST = resolve(process.env.EX_DIST ?? join(EX_REPO, 'dist'));
const SETUP_DIST = resolve(process.env.SETUP_DIST ?? 'dist/setup');
const SITES = { server: { root: DIST, port: 4178 }, shell: { root: SETUP_DIST, port: 4179 } };
const OUT_DIR = resolve(process.env.OUT_DIR ?? 'fastlane/screenshots/en-US');

const playwright = await import(join(EX_REPO, 'node_modules/playwright-core/index.js'));
const { chromium } = playwright.default ?? playwright;

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ex/1.0 Chrome/146.0.0.0 Electron/44.4.5 Safari/537.36';

// 1440x900 points at 2x: a 2880x1800 Retina window, the largest 16:10 size
// App Store Connect takes for Mac.
const DEVICE = { name: 'mac', scale: 2, viewport: { width: 1440, height: 900 } };

// The chat window drops the native title bar (titleBarStyle: hiddenInset) and
// macOS draws the traffic lights over the web content; the web client pads its
// top bar past them (.electron-mac). Draw them so the shots show the window as
// it looks on a Mac rather than an unexplained gap.
const TRAFFIC_LIGHTS = `
  (() => {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:18px;left:20px;display:flex;gap:8px;z-index:2147483647;pointer-events:none';
    for (const [fill, ring] of [['#FF5F57', '#E0443E'], ['#FEBC2E', '#DEA123'], ['#28C840', '#1AAB29']]) {
      const dot = document.createElement('span');
      dot.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + fill + ';box-shadow:inset 0 0 0 0.5px ' + ring;
      bar.appendChild(dot);
    }
    document.body.appendChild(bar);
  })();
`;

const MIME = new Map([
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.css', 'text/css'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json'],
  ['.woff2', 'font/woff2'],
  ['.png', 'image/png'],
]);

// A request path is untrusted input even though we launched the browser
// ourselves, so it never reaches the filesystem unchecked: it is resolved
// inside the built client and refused if it climbs out, before and after
// realpath() (a symlink inside dist must not point out of it either).
// Extension-less paths are SPA routes and get index.html; anything else that
// does not resolve to a real file inside dist is a 404.
async function fileForRequest(root, rawUrl) {
  let requestPath;
  try {
    requestPath = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (requestPath.includes('\0')) return null;
  if (!extname(requestPath)) return join(root, 'index.html');

  const base = await realpath(root);
  const candidate = resolve(base, `.${requestPath}`);
  if (!candidate.startsWith(base + sep)) return null;

  let file;
  try {
    file = await realpath(candidate);
  } catch {
    return null;
  }
  return file.startsWith(base + sep) ? file : null;
}

function serveStatic(root, port) {
  const server = createServer(async (req, res) => {
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    const file = readOnly ? await fileForRequest(root, req.url ?? '/') : null;
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME.get(extname(file)) ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  });
  // Loopback only — nothing off this machine has any business with it.
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------- fixtures
// Fixture times are relative to the render, so the UI's "4 hours ago" reads
// naturally whenever a shot is (re)generated instead of ageing into "3 months
// ago". Anchored to the top of the hour so one run is internally consistent.
const NOW = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const ME = { id: 'u-me', email: 'you@example.com', displayName: 'Maya Lindqvist', systemRole: 'admin', status: 'active' };
const PEOPLE = [
  ME,
  { id: 'u-jonas', email: 'jonas@example.com', displayName: 'Jonas Ek', systemRole: 'member', status: 'active' },
  { id: 'u-amira', email: 'amira@example.com', displayName: 'Amira Haddad', systemRole: 'member', status: 'active' },
  { id: 'u-sven', email: 'sven@example.com', displayName: 'Sven Ohlsson', systemRole: 'member', status: 'active' },
];
const CHANNELS = [
  { channelID: 'ch-general', channelName: 'general', channelType: 'public', role: 1, sidebarPosition: 1000 },
  { channelID: 'ch-interpreters', channelName: 'interpreters', channelType: 'public', role: 1, sidebarPosition: 2000, unread: true, unreadNotifyCount: 2 },
  { channelID: 'ch-releases', channelName: 'releases', channelType: 'public', role: 1, sidebarPosition: 3000 },
  { channelID: 'ch-leadership', channelName: 'leadership', channelType: 'private', role: 1, sidebarPosition: 4000 },
];
const CONVERSATIONS = [
  { conversationID: 'cv-jonas', type: 'dm', displayName: 'Jonas Ek', participantIDs: ['u-me', 'u-jonas'], updatedAt: at(40) },
  { conversationID: 'cv-team', type: 'group', displayName: 'Release crew', participantIDs: ['u-me', 'u-amira', 'u-sven'], updatedAt: at(90) },
];

function at(minutesAgo) {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}
function dm(id, authorID, body, minutesAgo, extra = {}) {
  return { id, parentID: 'cv-jonas', parentType: 'conversation', authorID, body, createdAt: at(minutesAgo), ...extra };
}
function msg(id, authorID, body, minutesAgo, extra = {}) {
  return { id, parentID: 'ch-interpreters', parentType: 'channel', authorID, body, createdAt: at(minutesAgo), ...extra };
}

const CHANNEL_MESSAGES = [
  msg('e1', 'u-me', 'Reminder: the autumn availability sheet closes on Friday — add your blocked days before then.', 320),
  msg('e2', 'u-amira', 'Added mine. Two court days in Uppsala next week, otherwise open.', 300),
  msg('e3', 'u-sven', 'Same here. I also updated the travel notes for the Gothenburg assignments.', 286, { reactions: { '👍': ['u-me'] } }),
  msg('e4', 'u-jonas', 'Is the phone-interpreting rota still Tuesdays and Thursdays?', 250),
  msg('e5', 'u-me', 'Yes, unchanged. The handbook has the full schedule if you need it.', 240),
  msg('m1', 'u-amira', 'Morning! The Stockholm on-site for Thursday needs one more Arabic interpreter — 09:00 to 12:00.', 182),
  msg('m2', 'u-jonas', 'I can take it. Is it the same address as last month?', 176),
  msg('m3', 'u-amira', 'Yes, same building — entrance on the north side this time.', 170, { reactions: { '👍': ['u-me', 'u-sven'] } }),
  msg('m4', 'u-sven', 'Booking confirmed and the client has been notified. 🎉', 154, {
    replyCount: 3,
    lastReplyAt: at(96),
    recentReplyAuthorIDs: ['u-jonas', 'u-amira'],
  }),
  msg('m5', 'u-me', 'Thanks both. I added the details to the shared calendar so the on-call rota picks it up.', 148),
  msg('m6', 'u-jonas', 'Quick heads-up: the Malmö court booking on Friday moved to 13:30.', 121),
  msg('m7', 'u-amira', 'Noted — I let the client know and updated the assignment.', 115, { reactions: { '🙏': ['u-jonas'] } }),
  msg('m8', 'u-sven', 'Reminder that the new interpreter handbook is pinned at the top of this channel.', 74, { pinned: true }),
  msg('m9', 'u-me', 'Anyone free for a 20-minute Swedish–Somali session tomorrow at 10:00?', 32),
  msg('m10', 'u-jonas', 'I can cover it. Sending the confirmation over now.', 12, { reactions: { '✅': ['u-me', 'u-amira', 'u-sven'] } }),
];
const THREAD_REPLIES = [
  CHANNEL_MESSAGES.find((m) => m.id === 'm4'),
  msg('t1', 'u-jonas', 'Adding it to my calendar now.', 130, { parentMessageID: 'm4' }),
  msg('t2', 'u-amira', 'I will send the briefing notes over this afternoon.', 112, { parentMessageID: 'm4' }),
  msg('t3', 'u-jonas', 'Perfect — see you Thursday.', 96, { parentMessageID: 'm4' }),
];
const DM_MESSAGES = [
  dm('d1', 'u-jonas', 'Could you review the interpreter onboarding checklist before Friday?', 300),
  dm('d2', 'u-me', 'Sure — sending comments tonight. Is the Swedish version final?', 292),
  dm('d3', 'u-jonas', 'Almost. The legal terminology section still needs a second pair of eyes.', 286),
  dm('d4', 'u-me', 'I can ask Amira, she wrote most of the court glossary.', 240),
  dm('d5', 'u-jonas', 'That would help a lot. No rush before Friday.', 231),
  dm('d6', 'u-me', 'Done — she will look at it tomorrow morning.', 96, { reactions: { '👍': ['u-jonas'] } }),
  dm('d7', 'u-jonas', 'Thank you! 🙏', 88, { reactions: { '❤️': ['u-me'] } }),
  dm('d8', 'u-me', 'One more thing: the Malmö booking moved to 13:30, I updated the calendar invite.', 26),
  dm('d9', 'u-jonas', 'Got it, thanks for the heads-up.', 14),
];

const RELEASE_THREAD = [
  { id: 'r1', parentID: 'ch-releases', parentType: 'channel', authorID: 'u-me', body: 'Release 2.4 is out: faster search and the new interpreter handbook.', createdAt: at(400), replyCount: 2, lastReplyAt: at(210), recentReplyAuthorIDs: ['u-amira', 'u-sven'] },
  { id: 'r2', parentID: 'ch-releases', parentType: 'channel', authorID: 'u-amira', body: 'Search feels noticeably quicker on the desktop app, nice work.', createdAt: at(260), parentMessageID: 'r1', reactions: { '🎉': ['u-me', 'u-jonas'] } },
  { id: 'r3', parentID: 'ch-releases', parentType: 'channel', authorID: 'u-sven', body: 'Handbook link is pinned in ~interpreters as well.', createdAt: at(210), parentMessageID: 'r1' },
];

// GET /api/v1/channels/:slug returns the channel record (not the sidebar row).
const CHANNEL_DETAIL = {
  id: 'ch-interpreters',
  name: 'interpreters',
  slug: 'interpreters',
  description: 'Scheduling and hand-overs for on-site interpreting',
  type: 'public',
  createdBy: 'u-me',
  archived: false,
  createdAt: at(60 * 24 * 90),
  updatedAt: at(12),
};

// GET /api/v1/conversations/:id returns the conversation record.
const CONVERSATION_DETAIL = {
  id: 'cv-jonas',
  type: 'dm',
  participantIDs: ['u-me', 'u-jonas'],
  createdBy: 'u-me',
  activated: true,
  createdAt: at(60 * 24 * 30),
  updatedAt: at(70),
};

function windowOf(chronological) {
  // The API hands the newest message back first; the list renders bottom-up.
  const items = [...chronological].reverse();
  return {
    items,
    hasMoreOlder: false,
    hasMoreNewer: false,
    oldestID: chronological[0]?.id,
    newestID: chronological[chronological.length - 1]?.id,
  };
}

const ROUTES = [
  [/\/auth\/token\/refresh$/, { accessToken: 'screenshot-token', expiresIn: 3600 }],
  [/\/api\/v1\/users\/me$/, ME],
  [/\/api\/v1\/users\/batch/, PEOPLE],
  // The directory calls /users with no query; keep both shapes answered.
  [/\/api\/v1\/users(\?|$)/, PEOPLE],
  [/\/api\/v1\/channels$/, CHANNELS],
  [/\/api\/v1\/channels\/[^/]+\/messages\/m4\/thread$/, THREAD_REPLIES],
  [/\/api\/v1\/channels\/[^/]+\/messages\/r1\/thread$/, RELEASE_THREAD],
  [/\/api\/v1\/channels\/ch-interpreters\/messages/, windowOf(CHANNEL_MESSAGES)],
  [/\/api\/v1\/channels\/[^/]+\/messages/, windowOf([])],
  [/\/api\/v1\/channels\/[^/]+\/members/, PEOPLE.map((user) => ({
    channelID: 'ch-interpreters',
    userID: user.id,
    role: user.id === ME.id ? 2 : 1,
    displayName: user.displayName,
    joinedAt: at(60 * 24 * 60),
  }))],
  [/\/api\/v1\/channels\/(interpreters|ch-interpreters)$/, CHANNEL_DETAIL],
  [/\/api\/v1\/channels\/[^/]+$/, CHANNEL_DETAIL],
  [/\/api\/v1\/conversations\/cv-jonas\/messages/, windowOf(DM_MESSAGES)],
  [/\/api\/v1\/conversations\/[^/]+\/messages/, windowOf([])],
  [/\/api\/v1\/conversations$/, CONVERSATIONS],
  [/\/api\/v1\/conversations\/[^/]+$/, CONVERSATION_DETAIL],
  [/\/api\/v1\/presence$/, { online: ['u-jonas', 'u-amira'] }],
  [/\/api\/v1\/threads$/, [
    {
      parentID: 'ch-interpreters',
      parentType: 'channel',
      threadRootID: 'm4',
      rootAuthorID: 'u-sven',
      rootBody: CHANNEL_MESSAGES.find((m) => m.id === 'm4').body,
      rootCreatedAt: CHANNEL_MESSAGES.find((m) => m.id === 'm4').createdAt,
      replyCount: 3,
      latestActivityAt: at(96),
    },
    {
      parentID: 'ch-releases',
      parentType: 'channel',
      threadRootID: 'r1',
      rootAuthorID: 'u-me',
      rootBody: 'Release 2.4 is out: faster search and the new interpreter handbook.',
      rootCreatedAt: at(400),
      replyCount: 2,
      latestActivityAt: at(210),
    },
  ]],
  [/\/api\/v1\/activity$/, { items: [], unread: 0 }],
  [/\/api\/v1\/emojis$/, []],
  [/\/api\/v1\/emojis\/frequent/, []],
  [/\/api\/v1\/version$/, {}],
  [/\/api\/v1\/drafts$/, []],
  [/\/api\/v1\/reminders$/, []],
  [/\/api\/v1\/commands$/, []],
  [/\/api\/v1\/sidebar\/categories$/, []],
  [/\/api\/v1\/user-state$/, { hiddenConversations: [], channelNotifications: [], threadNotifications: [], threadSeen: {} }],
  [/\/api\/v1\/admin\/settings$/, { maxUploadBytes: 10485760, allowedExtensions: [], giphyEnabled: false }],
];

const SHOTS = [
  { name: '01-channel', path: '/channel/interpreters', wait: 'Booking confirmed' },
  {
    name: '02-thread',
    path: '/channel/interpreters',
    wait: 'Booking confirmed',
    act: async (page) => {
      await page.getByText('3 replies', { exact: false }).first().click();
      await page.getByText('see you Thursday', { exact: false }).first().waitFor();
    },
  },
  { name: '03-direct-message', path: '/conversation/cv-jonas', wait: 'onboarding checklist' },
  { name: '04-threads', path: '/threads', wait: 'Booking confirmed' },
  // First launch: the app's own setup screen, before any server is known. It
  // opens in its own small window, not the chat window, so no traffic lights.
  { name: '05-connect-server', site: 'shell', path: '/setup.html', wait: 'Connect your workspace', chrome: false },
  // Then the server's own sign-in.
  { name: '06-sign-in', path: '/login', wait: 'Sign in', signedOut: true },
];

// Flipped per shot: a signed-out page needs the session endpoints to refuse.
let signedOut = false;

async function main() {
  if (!existsSync(DIST)) throw new Error(`built web client not found at ${DIST} — run "npm run build" in ${EX_REPO}`);
  if (!existsSync(SETUP_DIST)) throw new Error(`built setup screen not found at ${SETUP_DIST} — run "npm run build" here`);
  const force = process.argv.includes('--force') || process.env.FORCE_SCREENSHOTS === '1';
  await mkdir(OUT_DIR, { recursive: true });

  // Rendered only when missing: the UI prints relative timestamps against the
  // wall clock, so re-rendering rewrites identical-looking files for nothing.
  const work = SHOTS.map((shot) => ({ shot, file: join(OUT_DIR, `${DEVICE.name}-${shot.name}.png`) }))
    .filter(({ file }) => force || !existsSync(file));
  if (work.length === 0) {
    console.log('screenshots are already present — nothing to render (use --force to redo them)');
    return;
  }

  const servers = await Promise.all(
    Object.values(SITES).map(({ root, port }) => serveStatic(root, port)),
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: DEVICE.viewport,
    deviceScaleFactor: DEVICE.scale,
    userAgent: MAC_UA,
    colorScheme: 'light',
    permissions: ['notifications'],
  });
  // No live server: answer the client's calls from the fixtures, and keep the
  // WebSocket from retrying behind the UI.
  await context.route('**/api/v1/**', (route) => respond(route));
  await context.route('**/auth/**', (route) => respond(route));
  await context.addInitScript(() => {
    // What the Electron chat preload sets: the web client lays out for the
    // desktop shell (mouse-driven, traffic-light inset) instead of a tab.
    window.__EX_DESKTOP__ = true;
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
    // Permission already answered, so the in-app prompt banner stays away.
    Object.defineProperty(window, 'Notification', {
      value: Object.assign(function Notification() {}, {
        permission: 'granted',
        requestPermission: async () => 'granted',
      }),
    });
    class QuietSocket extends EventTarget {
      readyState = 0;
      close() {}
      send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: QuietSocket });
  });

  const page = await context.newPage();
  if (process.env.DEBUG_SCREENSHOTS) {
    page.on('console', (m) => console.log('[page]', m.type(), m.text().slice(0, 200)));
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
    page.on('requestfailed', (r) => console.log('[failed]', r.url().slice(0, 120)));
  }

  for (const { shot, file } of work) {
    signedOut = shot.signedOut === true;
    await context.clearCookies();
    const site = SITES[shot.site ?? 'server'];
    await page.goto(`http://127.0.0.1:${site.port}${shot.path}`, { waitUntil: 'domcontentloaded' });
    await page.getByText(shot.wait, { exact: false }).first().waitFor({ timeout: 20_000 });
    if (shot.act) await shot.act(page);
    if (shot.chrome !== false) await page.evaluate(TRAFFIC_LIGHTS);
    // A click leaves the cursor on a message row, which reveals its hover
    // toolbar — park it on empty chrome before capturing.
    await page.mouse.move(700, 4);
    await page.waitForTimeout(600);
    await writeFile(file, await page.screenshot({ scale: 'device' }));
    console.log(`wrote ${file}`);
  }

  await context.close();
  await browser.close();
  for (const server of servers) server.close();
}

function respond(route) {
  const url = route.request().url();
  // A signed-out page is produced by refusing the session endpoints, which is
  // what the client sees before anyone has logged in.
  if (signedOut && /\/auth\/token\/refresh$|\/api\/v1\/users\/me$/.test(url)) {
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
  }
  const match = ROUTES.find(([pattern]) => pattern.test(url));
  if (process.env.DEBUG_SCREENSHOTS) console.log(match ? '[api ok]' : '[api UNMATCHED]', url.replace('http://127.0.0.1:4178', ''));
  if (!match) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(match[1]) });
}

await main();
