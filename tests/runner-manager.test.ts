import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  RELEASES_API,
  RELEASE_DOWNLOAD,
  RunnerManager,
  augmentedPath,
  compareVersions,
  releaseAsset,
  type ChildLike,
  type RunResult,
  type RunnerManagerDeps,
  type RunnerState,
} from '../src/lib/runner-manager';

const SERVER = 'https://ex.example.com';

class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals: (NodeJS.Signals | undefined)[] = [];
  // How the fake answers a kill: exit at once (default), or ignore SIGTERM.
  onKill: (sig?: NodeJS.Signals) => void = () => this.emit('exit', 0);
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.onKill(signal);
    return true;
  }
  out(text: string) {
    this.stdout.emit('data', Buffer.from(text));
  }
  err(text: string) {
    this.stderr.emit('data', text);
  }
}

interface World {
  dir: string;
  binDir: string;
  sysDir: string;
  home: string;
  versions: Map<string, RunResult>;
  status: RunResult;
  logout: RunResult;
  tar: (args: string[]) => RunResult;
  children: { args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[];
  urls: Map<string, () => Response>;
  httpGet: Mock<(url: string) => Promise<void>>;
  confirm: Mock<(server: string) => Promise<boolean>>;
  auto: { on: boolean };
  states: RunnerState[];
  server: string | null;
  deps: RunnerManagerDeps;
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

function exe(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n');
}

function makeWorld(over: Partial<RunnerManagerDeps> = {}): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mgr-'));
  const w = {
    dir,
    binDir: path.join(dir, 'app', 'bin'),
    sysDir: path.join(dir, 'brew', 'bin'),
    home: path.join(dir, 'home', '.ex-runner'),
    versions: new Map<string, RunResult>(),
    status: ok(JSON.stringify({ connected: false, running: false })),
    logout: ok('Disconnected.'),
    tar: (_args: string[]) => ok(),
    children: [],
    urls: new Map<string, () => Response>(),
    httpGet: vi.fn(async (_url: string) => {}),
    confirm: vi.fn(async (_server: string) => true),
    auto: { on: false },
    states: [],
    server: SERVER as string | null,
  } as unknown as World;
  w.deps = {
    supported: true,
    platform: 'darwin',
    arch: 'arm64',
    binDir: w.binDir,
    home: w.home,
    searchDirs: [w.sysDir],
    serverUrl: () => w.server,
    env: { HOME: '/Users/alice', PATH: '/usr/bin:/bin' },
    spawn: (_cmd, args, env) => {
      const child = new FakeChild();
      w.children.push({ args, env, child });
      return child;
    },
    run: async (cmd, args) => {
      if (cmd === 'tar') return w.tar(args);
      if (args[0] === '--version') return w.versions.get(cmd) ?? { code: 1, stdout: '', stderr: 'no' };
      if (args[0] === 'status') return w.status;
      if (args[0] === 'logout') return w.logout;
      throw new Error(`unexpected run ${cmd} ${args.join(' ')}`);
    },
    fetch: async (url) => {
      const r = w.urls.get(url);
      if (!r) throw new Error(`offline: ${url}`);
      return r();
    },
    httpGet: w.httpGet,
    confirmConnect: w.confirm,
    autoStart: { get: () => w.auto.on, set: (on) => (w.auto.on = on) },
    onState: (s) => w.states.push(s),
    timeouts: { connectUrl: 50, connectFinish: 50, stop: 20 },
    ...over,
  };
  return w;
}

const appBin = (w: World) => path.join(w.binDir, 'ex-runner');
const sysBin = (w: World) => path.join(w.sysDir, 'ex-runner');

function installedApp(w: World, version = '0.0.3') {
  exe(appBin(w));
  w.versions.set(appBin(w), ok(`${version}\n`));
}

function connectedStatus(w: World, extra: Record<string, unknown> = {}) {
  w.status = ok(
    JSON.stringify({
      connected: true,
      server: SERVER,
      user: 'Alice',
      label: 'mac',
      tokenId: 'rt1',
      expiresAt: '2026-11-01T00:00:00Z',
      expired: false,
      running: false,
      ...extra,
    }),
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const last = (w: World) => w.states[w.states.length - 1];

let worlds: World[] = [];
function world(over?: Partial<RunnerManagerDeps>) {
  const w = makeWorld(over);
  worlds.push(w);
  return w;
}

afterEach(() => {
  for (const w of worlds) fs.rmSync(w.dir, { recursive: true, force: true });
  worlds = [];
});

describe('helpers', () => {
  it('compares versions, local builds last', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1')).toBe(0);
    expect(compareVersions('0.0.2', '0.0.3')).toBe(-1);
    expect(compareVersions('dev', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', 'dev')).toBe(-1);
    expect(compareVersions('dev', 'x')).toBe(0);
  });

  it('names the release archive for each computer', () => {
    expect(releaseAsset('0.0.3', 'darwin', 'arm64')).toBe('ex-runner-0.0.3-darwin-arm64');
    expect(releaseAsset('0.0.3', 'linux', 'x64')).toBe('ex-runner-0.0.3-linux-amd64');
    expect(releaseAsset('0.0.3', 'win32', 'x64')).toBe('ex-runner-0.0.3-windows-amd64');
    expect(releaseAsset('0.0.3', 'aix', 'x64')).toBeNull();
    expect(releaseAsset('0.0.3', 'linux', 'ia32')).toBeNull();
  });

  it('puts the agent CLIs’ usual homes on PATH', () => {
    expect(augmentedPath({ HOME: '/Users/a', PATH: '/usr/bin:/opt/homebrew/bin' }, 'darwin')).toBe(
      '/Users/a/.local/bin:/usr/local/bin:/usr/bin:/opt/homebrew/bin',
    );
    expect(augmentedPath({}, 'linux')).toBe('.local/bin:/opt/homebrew/bin:/usr/local/bin');
    expect(augmentedPath({ PATH: 'C:\\bin' }, 'win32')).toBe('C:\\bin');
  });
});

describe('RunnerManager', () => {
  it('refuses everything but its state in a build that cannot run ex-runner', async () => {
    const w = world({ supported: false });
    const m = new RunnerManager(w.deps);
    const got = await m.handle('getState', undefined);
    expect(got).toEqual({ ok: true, value: expect.objectContaining({ supported: false, binary: null }) });
    expect(await m.handle('start', undefined)).toEqual({ ok: false, error: "This version of the ex app can't run ex-runner." });
    expect(await m.handle('reboot', undefined)).toEqual({ ok: false, error: 'Unknown runner action.' });
    expect(await m.handle(42, undefined)).toEqual({ ok: false, error: 'Unknown runner action.' });
  });

  it('reports nothing installed, and the newest release once it is known', async () => {
    const w = world();
    w.urls.set(RELEASES_API, () => Response.json({ tag_name: 'v0.0.4' }));
    const m = new RunnerManager(w.deps);
    const st = await m.getState();
    expect(st).toMatchObject({ supported: true, binary: null, connection: null, process: 'stopped', busy: null });
    await flush();
    expect(last(w).latestVersion).toBe('0.0.4');
    // Cached: a second read doesn't ask GitHub again, and no change, no push.
    const fetches = vi.spyOn(w.deps, 'fetch');
    const pushes = w.states.length;
    await m.getState();
    await flush();
    expect(fetches).not.toHaveBeenCalled();
    expect(w.states.length).toBe(pushes + 1);
  });

  it('shrugs off an unreachable or odd release feed', async () => {
    for (const make of [
      undefined,
      () => new Response('nope', { status: 500 }),
      () => new Response('not json'),
      () => Response.json({ tag_name: 'latest' }),
      () => Response.json({}),
    ]) {
      const w = world();
      if (make) w.urls.set(RELEASES_API, make);
      const m = new RunnerManager(w.deps);
      await m.getState();
      await flush();
      expect(last(w).latestVersion).toBeNull();
    }
  });

  it('finds Homebrew’s copy, reads its sign-in, and sees it running outside the app', async () => {
    const w = world();
    exe(sysBin(w));
    w.versions.set(sysBin(w), ok('0.0.3'));
    connectedStatus(w, { running: true, pid: 99, expired: true, user: 7 });
    const st = await new RunnerManager(w.deps).getState();
    expect(st.binary).toEqual({ version: '0.0.3', source: 'system' });
    expect(st.connection).toEqual({
      server: SERVER,
      user: '',
      label: 'mac',
      tokenId: 'rt1',
      expiresAt: '2026-11-01T00:00:00Z',
      expired: true,
    });
    expect(st).toMatchObject({ process: 'running', external: true });
  });

  it('prefers the app’s copy, skips broken ones, and leaves an old one unread', async () => {
    const w = world();
    exe(sysBin(w));
    w.versions.set(sysBin(w), ok('0.0.9'));
    installedApp(w, '0.0.3');
    expect((await new RunnerManager(w.deps).getState()).binary).toEqual({ version: '0.0.3', source: 'app' });

    // An app copy that can't print a version is skipped.
    w.versions.set(appBin(w), ok('  '));
    expect((await new RunnerManager(w.deps).getState()).binary?.source).toBe('system');
    w.versions.set(appBin(w), { code: 2, stdout: '0.0.3', stderr: '' });
    expect((await new RunnerManager(w.deps).getState()).binary?.source).toBe('system');

    // Too old to control: its status isn't asked for.
    w.versions.set(sysBin(w), ok('0.0.2'));
    connectedStatus(w);
    const status = vi.spyOn(w.deps, 'run');
    const st = await new RunnerManager(w.deps).getState();
    expect(st.binary?.version).toBe('0.0.2');
    expect(st.connection).toBeNull();
    expect(status.mock.calls.some((c) => c[1][0] === 'status')).toBe(false);
  });

  it('reads an unreadable or incomplete status as not connected', async () => {
    const w = world();
    installedApp(w);
    w.status = ok('{oops');
    expect((await new RunnerManager(w.deps).getState()).connection).toBeNull();
    w.status = ok(JSON.stringify({ connected: true, server: SERVER }));
    expect((await new RunnerManager(w.deps).getState()).connection).toBeNull();
  });

  it('runs a run() that throws as "no version"', async () => {
    const w = world({ run: async () => Promise.reject(new Error('spawn EACCES')) });
    exe(sysBin(w));
    expect((await new RunnerManager(w.deps).getState()).binary).toBeNull();
  });

  describe('install', () => {
    const NAME = 'ex-runner-0.0.3-darwin-arm64';
    const archive = Buffer.from('pretend tarball');
    const sha = crypto.createHash('sha256').update(archive).digest('hex');

    function release(w: World, opts: { sums?: string; sumsStatus?: number; body?: Response } = {}) {
      w.urls.set(RELEASES_API, () => Response.json({ tag_name: 'v0.0.3' }));
      w.urls.set(`${RELEASE_DOWNLOAD}/v0.0.3/SHA256SUMS`, () =>
        new Response(opts.sums ?? `${'0'.repeat(64)}  other.tar.gz\n${sha}  ${NAME}.tar.gz\n`, { status: opts.sumsStatus ?? 200 }),
      );
      w.urls.set(
        `${RELEASE_DOWNLOAD}/v0.0.3/${NAME}.tar.gz`,
        () =>
          opts.body ??
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(archive.subarray(0, 5));
                c.enqueue(archive.subarray(5));
                c.close();
              },
            }),
            { headers: { 'content-length': String(archive.length) } },
          ),
      );
      // "tar" unpacks the release folder with the binary in it.
      w.tar = (args) => {
        const dest = args[args.indexOf('-C') + 1];
        exe(path.join(dest, NAME, 'ex-runner'));
        w.versions.set(appBin(w), ok('0.0.3'));
        return ok();
      };
    }

    it('downloads, checks and unpacks the release into the app’s folder', async () => {
      const w = world();
      release(w);
      const m = new RunnerManager(w.deps);
      expect(await m.handle('install', undefined)).toEqual({ ok: true, value: undefined });
      expect(fs.statSync(appBin(w)).mode & 0o111).toBeTruthy();
      expect(w.states.some((s) => s.busy === 'installing')).toBe(true);
      expect(w.states.filter((s) => s.progress !== null).map((s) => s.progress)).toEqual([5 / archive.length, 1]);
      expect(last(w)).toMatchObject({ busy: null, progress: null, binary: { version: '0.0.3', source: 'app' } });
      // The scratch folder is gone.
      expect(fs.readdirSync(path.dirname(w.binDir))).toEqual(['bin']);
    });

    it('reports progress only when the size is known', async () => {
      const w = world();
      release(w, { body: new Response(archive) });
      await new RunnerManager(w.deps).install();
      expect(w.states.every((s) => s.progress === null)).toBe(true);
    });

    it.each([
      ['no build for this computer', { platform: 'aix' }, {}, "isn't available for this computer"],
      ['checksums missing', {}, { sumsStatus: 404 }, 'checksums: HTTP 404'],
      ['no checksum line', {}, { sums: 'abc  other.tar.gz\n' }, 'has no download for this computer'],
      ['checksum mismatch', {}, { sums: `${'f'.repeat(64)}  ${NAME}.tar.gz` }, "didn't match its checksum"],
      ['download refused', {}, { body: new Response('x', { status: 503 }) }, 'HTTP 503'],
      ['no body', {}, { body: new Response(null) }, "Couldn't download ex-runner (HTTP 200)"],
    ])('fails cleanly: %s', async (_why, over, opts, msg) => {
      const w = world(over as Partial<RunnerManagerDeps>);
      release(w, opts as never);
      const m = new RunnerManager(w.deps);
      const res = await m.handle('install', undefined);
      expect(res).toEqual({ ok: false, error: expect.stringContaining(msg) });
      expect(last(w)).toMatchObject({ busy: null, error: expect.stringContaining(msg) });
      expect(fs.existsSync(appBin(w))).toBe(false);
    });

    it('fails cleanly when unpacking fails or the archive is wrong', async () => {
      const w = world();
      release(w);
      w.tar = () => ({ code: 2, stdout: '', stderr: 'tar: bad header\n' });
      expect(await new RunnerManager(w.deps).handle('install', undefined)).toEqual({
        ok: false,
        error: "Couldn't unpack ex-runner: tar: bad header",
      });
      w.tar = () => ({ code: 3, stdout: '', stderr: '' });
      expect(await new RunnerManager(w.deps).handle('install', undefined)).toEqual({
        ok: false,
        error: "Couldn't unpack ex-runner: tar exit 3",
      });
      w.tar = () => ok();
      const res = await new RunnerManager(w.deps).handle('install', undefined);
      expect(res.ok).toBe(false);
    });

    it('fails when the release feed is down', async () => {
      const w = world();
      const res = await new RunnerManager(w.deps).handle('install', undefined);
      expect(res).toEqual({ ok: false, error: "Couldn't find the latest ex-runner release. Check your connection." });
    });

    it('stops the runner it is running, swaps the binary, and starts it again', async () => {
      const w = world();
      installedApp(w, '0.0.3');
      connectedStatus(w);
      const m = new RunnerManager(w.deps);
      await m.refresh();
      await m.start();
      const first = w.children[0].child;
      release(w);
      await m.install();
      expect(first.signals).toEqual(['SIGTERM']);
      expect(w.children.map((c) => c.args)).toEqual([['start'], ['start']]);
      expect(last(w).process).toBe('starting');
    });

    it('does one thing at a time', async () => {
      const w = world();
      release(w);
      const m = new RunnerManager(w.deps);
      const a = m.install();
      await expect(m.install()).rejects.toThrow('busy');
      await a;
    });
  });

  describe('connect', () => {
    const LINK = `${SERVER}/runner/connect?port=50123&state=st-1&challenge=ch-1&name=mac`;

    async function ready() {
      const w = world();
      installedApp(w);
      const m = new RunnerManager(w.deps);
      await m.refresh();
      return { w, m };
    }

    it('asks natively first, then hands the SPA what it needs to approve', async () => {
      const { w, m } = await ready();
      const begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(1));
      const { args, env, child } = w.children[0];
      expect(args).toEqual(['login', '--no-browser', SERVER]);
      expect(env.EX_RUNNER_HOME).toBe(w.home);
      child.out('Opening your browser…\nIf it doesn\'t open, visit this link on this computer:\n\n  ');
      child.out(`${LINK}\n`);
      expect(await begin).toEqual({ port: 50123, state: 'st-1', challenge: 'ch-1', name: 'mac' });
      expect(w.confirm).toHaveBeenCalledWith(SERVER);
      expect(last(w).busy).toBe('connecting');

      // The code goes to the runner's callback; the runner signs in and exits.
      connectedStatus(w);
      const finish = m.finishConnect('one-time-code');
      await vi.waitFor(() =>
        expect(w.httpGet).toHaveBeenCalledWith('http://127.0.0.1:50123/callback?code=one-time-code&state=st-1'),
      );
      child.emit('exit', 0);
      await finish;
      expect(last(w)).toMatchObject({ busy: null, connection: { tokenId: 'rt1' } });
    });

    it('defaults the computer name', async () => {
      const { w, m } = await ready();
      const begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(1));
      w.children[0].child.out(`${SERVER}/runner/connect?port=50123&state=s&challenge=c\n`);
      expect((await begin).name).toBe('this computer');
    });

    it('refuses without a workspace, without a usable ex-runner, or when declined', async () => {
      const { w, m } = await ready();
      w.confirm.mockResolvedValueOnce(false);
      await expect(m.beginConnect()).rejects.toThrow('cancelled');
      expect(w.children).toHaveLength(0);
      w.server = null;
      await expect(m.beginConnect()).rejects.toThrow('Connect the app to a workspace first.');
      w.server = SERVER;
      w.versions.set(appBin(w), ok('0.0.2'));
      await m.refresh();
      await expect(m.beginConnect()).rejects.toThrow('Install or update ex-runner first.');
      const bare = new RunnerManager(world().deps);
      await expect(bare.beginConnect()).rejects.toThrow('Install or update ex-runner first.');
    });

    it('reports a login that dies, stalls, or points elsewhere', async () => {
      const { w, m } = await ready();
      let begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(1));
      w.children[0].child.err('Usage: ex-runner login <server-url>\n');
      w.children[0].child.emit('exit', 2);
      await expect(begin).rejects.toThrow('Usage: ex-runner login <server-url>');
      expect(last(w)).toMatchObject({ busy: null, error: 'Usage: ex-runner login <server-url>' });

      begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(2));
      w.children[1].child.emit('error', new Error('ENOENT'));
      await expect(begin).rejects.toThrow('ex-runner login exited (1).');

      begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(3));
      w.children[2].child.emit('exit', null);
      await expect(begin).rejects.toThrow('ex-runner login exited (1).');

      await expect(m.beginConnect()).rejects.toThrow("ex-runner didn't start signing in.");

      for (const link of [
        `https://evil.example/runner/connect?port=50123&state=s&challenge=c`,
        `${SERVER}/runner/connect?port=80&state=s&challenge=c`,
        `${SERVER}/runner/connect?port=50123&challenge=c`,
        `${SERVER}/runner/connect?port=50123&state=s`,
      ]) {
        const n = w.children.length;
        begin = m.beginConnect();
        await vi.waitFor(() => expect(w.children).toHaveLength(n + 1));
        const child = w.children[n].child;
        child.out(`${link}\n`);
        await expect(begin).rejects.toThrow('somewhere unexpected');
        expect(child.signals).toEqual([undefined]);
      }
    });

    it('finishes only a waiting connection with a well-formed code', async () => {
      const { w, m } = await ready();
      await expect(m.finishConnect('abcdefgh')).rejects.toThrow('No connection is waiting.');
      const begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(1));
      w.children[0].child.out(`${LINK}\n`);
      await begin;
      // A malformed code is refused and the connection keeps waiting.
      await expect(m.finishConnect('bad code!')).rejects.toThrow('That sign-in code is invalid.');
      await expect(m.finishConnect(42)).rejects.toThrow('That sign-in code is invalid.');
      expect(w.httpGet).not.toHaveBeenCalled();
      await m.cancelConnect();
    });

    it('reports a sign-in that fails or never finishes', async () => {
      const { w, m } = await ready();
      for (const [exit, msg] of [
        [1, 'ex-runner could not finish signing in.'],
        [null, 'ex-runner took too long to sign in.'],
      ] as const) {
        const n = w.children.length;
        const begin = m.beginConnect();
        await vi.waitFor(() => expect(w.children).toHaveLength(n + 1));
        const child = w.children[n].child;
        child.onKill = () => {};
        child.out(`${LINK}\n`);
        await begin;
        const finish = m.finishConnect('one-time-code');
        if (exit !== null) {
          await vi.waitFor(() => expect(w.httpGet).toHaveBeenCalled());
          child.emit('exit', exit);
        }
        await expect(finish).rejects.toThrow(msg);
        expect(child.signals).toEqual([undefined]);
        expect(last(w)).toMatchObject({ busy: null, error: msg });
      }
    });

    it('cancels a waiting connection, even when the runner already left', async () => {
      const { w, m } = await ready();
      await m.cancelConnect(); // nothing waiting: nothing happens
      expect(w.httpGet).not.toHaveBeenCalled();
      for (const fail of [false, true]) {
        const n = w.children.length;
        const begin = m.beginConnect();
        await vi.waitFor(() => expect(w.children).toHaveLength(n + 1));
        w.children[n].child.out(`${LINK}\n`);
        await begin;
        if (fail) w.httpGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await m.cancelConnect();
        expect(w.httpGet).toHaveBeenLastCalledWith('http://127.0.0.1:50123/callback?error=cancelled&state=st-1');
        expect(w.children[n].child.signals).toEqual([undefined]);
        expect(last(w).busy).toBeNull();
      }
    });

    it('does not start connecting while busy', async () => {
      const { w, m } = await ready();
      const begin = m.beginConnect();
      await vi.waitFor(() => expect(w.children).toHaveLength(1));
      await expect(m.beginConnect()).rejects.toThrow('busy');
      w.children[0].child.out(`${LINK}\n`);
      await begin;
    });
  });

  describe('run', () => {
    async function connected(extra: Record<string, unknown> = {}) {
      const w = world();
      installedApp(w);
      connectedStatus(w, extra);
      const m = new RunnerManager(w.deps);
      await m.refresh();
      return { w, m };
    }

    it('starts ex-runner, follows it online, keeps its log, and stops it', async () => {
      const { w, m } = await connected();
      await m.start();
      const { args, env, child } = w.children[0];
      expect(args).toEqual(['start']);
      expect(env.EX_RUNNER_HOME).toBe(w.home);
      expect(env.PATH).toBe('/Users/alice/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
      expect(last(w).process).toBe('starting');
      // While our runner holds the lock, status says "running" — that's ours.
      connectedStatus(w, { running: true });
      await m.refresh();
      expect(last(w)).toMatchObject({ process: 'starting', external: false });
      child.out('2026-10-16T08:00:00Z registered {"agents":["gg"]}\n\nex-runner is online for Alice on x. Press Ctrl-C to stop.\n');
      expect(last(w).process).toBe('running');
      child.out('ex-runner is online again\n'); // only the first online line counts
      child.err('a warning\n');
      expect(await m.handle('readLog', undefined)).toEqual({
        ok: true,
        value: [
          '2026-10-16T08:00:00Z registered {"agents":["gg"]}',
          'ex-runner is online for Alice on x. Press Ctrl-C to stop.',
          'ex-runner is online again',
          'a warning',
        ],
      });
      await m.start(); // already running: nothing new
      expect(w.children).toHaveLength(1);

      connectedStatus(w);
      await m.stop();
      expect(child.signals).toEqual(['SIGTERM']);
      expect(last(w)).toMatchObject({ process: 'stopped', error: null });
      await m.stop(); // nothing running: nothing to do
    });

    it('keeps only the newest log lines', async () => {
      const { w, m } = await connected();
      await m.start();
      w.children[0].child.out(Array.from({ length: 520 }, (_, i) => `line ${i}`).join('\n'));
      const log = (await m.handle('readLog', undefined)) as { value: string[] };
      expect(log.value).toHaveLength(500);
      expect(log.value[0]).toBe('line 20');
    });

    it('says why when ex-runner stops on its own', async () => {
      const { w, m } = await connected();
      await m.start();
      w.children[0].child.err('This runner was disconnected — it was removed on the Runners page.\n');
      w.children[0].child.emit('exit', 1);
      await flush();
      expect(last(w)).toMatchObject({
        process: 'stopped',
        error: 'ex-runner stopped unexpectedly (exit 1): This runner was disconnected — it was removed on the Runners page.',
      });

      await m.start();
      w.children[1].child.emit('error', new Error('spawn ENOENT'));
      await flush();
      expect(last(w).error).toBe('ex-runner stopped unexpectedly: spawn ENOENT');
      // A late exit from a replaced child changes nothing.
      w.children[1].child.emit('exit', 0);

      await m.start();
      w.children[2].child.emit('exit', 0);
      await flush();
      expect(last(w).error).toBe('ex-runner stopped unexpectedly (exit 0).');
    });

    it('kills a runner that ignores the polite stop', async () => {
      const { w, m } = await connected();
      await m.start();
      const child = w.children[0].child;
      child.onKill = (sig) => {
        if (sig === 'SIGKILL') child.emit('exit', null);
      };
      await m.stop();
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(last(w).process).toBe('stopped');
    });

    it('refuses to start without a connection or next to another runner', async () => {
      const w = world();
      installedApp(w);
      const m = new RunnerManager(w.deps);
      await m.refresh();
      await expect(m.start()).rejects.toThrow('Connect this computer first.');
      const { m: m2 } = await connected({ running: true });
      await expect(m2.start()).rejects.toThrow('ex-runner is already running on this computer.');
      await expect(m2.stop()).rejects.toThrow('running outside the app');
    });

    it('remembers "start when ex opens"', async () => {
      const { w, m } = await connected();
      expect(await m.handle('setAutoStart', { on: true })).toEqual({ ok: true, value: undefined });
      expect(w.auto.on).toBe(true);
      expect(last(w).autoStart).toBe(true);
      await m.handle('setAutoStart', null);
      expect(w.auto.on).toBe(false);
    });

    it('stops its runner and any waiting connection on shutdown', async () => {
      const { w, m } = await connected();
      await m.start();
      await m.shutdown();
      expect(w.children[0].child.signals).toEqual(['SIGTERM']);

      const fresh = await connected();
      const b = fresh.m.beginConnect();
      await vi.waitFor(() => expect(fresh.w.children).toHaveLength(1));
      fresh.w.children[0].child.out(`${SERVER}/runner/connect?port=50123&state=s&challenge=c\n`);
      await b;
      await fresh.m.shutdown();
      expect(fresh.w.children[0].child.signals).toEqual([undefined]);
      expect(last(fresh.w).busy).toBeNull();
    });
  });

  describe('disconnect and remove', () => {
    it('logs out after stopping the runner, and reports a failed logout', async () => {
      const w = world();
      installedApp(w);
      connectedStatus(w);
      const m = new RunnerManager(w.deps);
      await m.refresh();
      await m.start();
      w.status = ok(JSON.stringify({ connected: false }));
      expect(await m.handle('disconnect', undefined)).toEqual({ ok: true, value: undefined });
      expect(w.children[0].child.signals).toEqual(['SIGTERM']);
      expect(last(w)).toMatchObject({ connection: null, busy: null });

      w.logout = { code: 1, stdout: '', stderr: "Couldn't reach the server.\n" };
      expect(await m.handle('disconnect', undefined)).toEqual({ ok: false, error: "Couldn't reach the server." });
      w.logout = { code: 1, stdout: '', stderr: '' };
      expect(await m.handle('disconnect', undefined)).toEqual({ ok: false, error: 'ex-runner could not disconnect.' });
      expect(await new RunnerManager(world().deps).handle('disconnect', undefined)).toEqual({
        ok: false,
        error: 'ex-runner is not installed.',
      });
    });

    it('removes only the copy the app installed', async () => {
      const w = world();
      installedApp(w);
      const m = new RunnerManager(w.deps);
      await m.refresh();
      expect(await m.handle('uninstall', undefined)).toEqual({ ok: true, value: undefined });
      expect(fs.existsSync(appBin(w))).toBe(false);
      expect(last(w).binary).toBeNull();

      exe(sysBin(w));
      w.versions.set(sysBin(w), ok('0.0.3'));
      await m.refresh();
      expect(await m.handle('uninstall', undefined)).toEqual({
        ok: false,
        error: 'Only the copy ex installed can be removed here.',
      });
    });

    it('words an error without a message', async () => {
      const w = world();
      installedApp(w);
      const m = new RunnerManager({ ...w.deps, autoStart: { get: () => false, set: () => { throw new Error(''); } } });
      expect(await m.handle('setAutoStart', { on: true })).toEqual({ ok: false, error: 'Something went wrong.' });
    });
  });

  it('drives every action through the IPC entry point, with the real waits', async () => {
    const w = world({ timeouts: undefined });
    installedApp(w);
    connectedStatus(w);
    const m = new RunnerManager(w.deps);
    await m.refresh();
    expect(await m.handle('start', undefined)).toEqual({ ok: true, value: undefined });
    expect(await m.handle('stop', undefined)).toEqual({ ok: true, value: undefined });
    const begin = m.handle('beginConnect', undefined);
    await vi.waitFor(() => expect(w.children).toHaveLength(2));
    const login = w.children[1].child;
    login.out(`${SERVER}/runner/connect?port=50123&state=s&challenge=c&name=mac\n`);
    expect(await begin).toEqual({ ok: true, value: { port: 50123, state: 's', challenge: 'c', name: 'mac' } });
    const finish = m.handle('finishConnect', { code: 'one-time-code' });
    await vi.waitFor(() => expect(w.httpGet).toHaveBeenCalled());
    login.emit('exit', 0);
    expect(await finish).toEqual({ ok: true, value: undefined });
    expect(await m.handle('cancelConnect', undefined)).toEqual({ ok: true, value: undefined });
  });

  it('lets go of a runner that ignores even SIGKILL', async () => {
    const w = world();
    installedApp(w);
    connectedStatus(w);
    const m = new RunnerManager(w.deps);
    await m.refresh();
    await m.start();
    const child = w.children[0].child;
    child.onKill = () => {};
    await m.stop();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(last(w).process).toBe('stopped');
  });

  it('uses the .exe name on Windows', async () => {
    const w = world({ platform: 'win32' });
    exe(path.join(w.binDir, 'ex-runner.exe'));
    w.versions.set(path.join(w.binDir, 'ex-runner.exe'), ok('0.0.3'));
    expect((await new RunnerManager(w.deps).getState()).binary).toEqual({ version: '0.0.3', source: 'app' });
  });
});

beforeEach(() => {
  vi.useRealTimers();
});
