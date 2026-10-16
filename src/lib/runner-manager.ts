// RunnerManager installs, connects and runs ex-runner (github.com/DigitalTolk/
// ex-runners) on this computer for the SPA's Runners tab. It replaces the
// agent runner that used to live inside this app: the work happens in the
// separate ex-runner binary, and the app only drives its command line —
//
//   install     download the release for this OS/arch, check its SHA-256,
//               unpack it into the app's own folder
//   connect     `ex-runner login --no-browser <server>`; the SPA approves the
//               pairing with its session and the code goes back to the
//               runner's localhost callback (the runner token never leaves
//               ex-runner)
//   start/stop  `ex-runner start` as a child of the app, with its output kept
//               for the log view
//
// It shares ex-runner's home (~/.ex-runner, or EX_RUNNER_HOME) with a copy
// installed from Homebrew, so a computer has one sign-in and one running
// runner, whichever way it was set up. Nothing installs, connects or runs
// until the person asks for it in the SPA.
//
// Every process, network and dialog call arrives through RunnerManagerDeps,
// so this file stays testable without Electron; main.ts supplies the real ones.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RELEASES_API = 'https://api.github.com/repos/DigitalTolk/ex-runners/releases/latest';
export const RELEASE_DOWNLOAD = 'https://github.com/DigitalTolk/ex-runners/releases/download';

// The oldest ex-runner the app can drive (`login --no-browser`, `status --json`).
export const MIN_CONTROLLABLE_VERSION = '0.0.3';

const LOG_LINES = 500;
const LATEST_TTL_MS = 6 * 60 * 60_000;
const CONNECT_URL_TIMEOUT_MS = 15_000;
const CONNECT_FINISH_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const ONLINE_LINE = /ex-runner is online/;

export type RunnerProcess = 'stopped' | 'starting' | 'running' | 'stopping';
export type RunnerBusy = 'installing' | 'connecting' | 'disconnecting' | 'removing';

export interface RunnerConnection {
  server: string;
  user: string;
  label: string;
  tokenId: string;
  expiresAt: string;
  expired: boolean;
}

// RunnerState is what the SPA's Runners tab renders (read there by
// readState in src/lib/desktop-runner.ts — keep the two in step).
export interface RunnerState {
  supported: boolean;
  binary: { version: string; source: 'app' | 'system' } | null;
  latestVersion: string | null;
  connection: RunnerConnection | null;
  process: RunnerProcess;
  external: boolean;
  autoStart: boolean;
  busy: RunnerBusy | null;
  progress: number | null;
  error: string | null;
}

export interface ConnectRequest {
  port: number;
  state: string;
  challenge: string;
  name: string;
}

// The slice of a child process the manager uses.
export interface ChildLike {
  pid?: number;
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunnerManagerDeps {
  // False in the Mac App Store build: its sandbox can't run ex-runner.
  supported: boolean;
  platform: string;
  arch: string;
  // The app's own copy of ex-runner lives here.
  binDir: string;
  // ex-runner's home (credentials, lock, state).
  home: string;
  // Where else to look for an ex-runner (Homebrew, PATH).
  searchDirs: string[];
  serverUrl: () => string | null;
  env: NodeJS.ProcessEnv;
  spawn: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildLike;
  run: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;
  fetch: (url: string) => Promise<Response>;
  // The runner's localhost login callback.
  httpGet: (url: string) => Promise<void>;
  // A native "connect this computer?" dialog — the page can't click it.
  confirmConnect: (server: string) => Promise<boolean>;
  autoStart: { get(): boolean; set(on: boolean): void };
  onState: (state: RunnerState) => void;
  now?: () => number;
  // Test seams for the long waits.
  timeouts?: { connectUrl?: number; connectFinish?: number; stop?: number };
}

// compareVersions orders dotted release versions numerically. A local build
// ("dev", or anything non-numeric) sorts above every release.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// releaseAsset names the archive for this computer, or null when ex-runner
// isn't built for it.
export function releaseAsset(version: string, platform: string, arch: string): string | null {
  const os = ({ darwin: 'darwin', linux: 'linux', win32: 'windows' } as Record<string, string>)[platform];
  const cpu = ({ arm64: 'arm64', x64: 'amd64' } as Record<string, string>)[arch];
  return os && cpu ? `ex-runner-${version}-${os}-${cpu}` : null;
}

// augmentedPath puts the usual install places for the agent CLIs ahead of
// the GUI app's minimal PATH, so the runner finds `claude` and `codex`.
export function augmentedPath(env: NodeJS.ProcessEnv, platform: string): string {
  const sep = platform === 'win32' ? ';' : ':';
  const extra =
    platform === 'win32' ? [] : [path.join(env.HOME ?? '', '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const current = (env.PATH ?? '').split(sep).filter(Boolean);
  return [...extra.filter((d) => !current.includes(d)), ...current].join(sep);
}

const lastLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? '';

const message = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong.');

// raceTimeout resolves with the promise's value, or `fallback` after ms —
// and clears its timer either way, so nothing lingers in the app.
async function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class RunnerManager {
  private readonly d: RunnerManagerDeps;
  private readonly exe: string;
  private bin: { path: string; version: string; source: 'app' | 'system' } | null = null;
  private connection: RunnerConnection | null = null;
  private externalRunning = false;
  private child: ChildLike | null = null;
  private childOnline = false;
  private stopping = false;
  private busy: RunnerBusy | null = null;
  private progress: number | null = null;
  private error: string | null = null;
  private latest: { version: string; at: number } | null = null;
  private log: string[] = [];
  private pending: { proc: ChildLike; port: number; state: string; exited: Promise<number> } | null = null;

  constructor(deps: RunnerManagerDeps) {
    this.d = deps;
    this.exe = deps.platform === 'win32' ? 'ex-runner.exe' : 'ex-runner';
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  state(): RunnerState {
    const bin = this.bin;
    return {
      supported: this.d.supported,
      binary: bin ? { version: bin.version, source: bin.source } : null,
      latestVersion: this.latest?.version ?? null,
      connection: this.connection,
      process: this.child
        ? this.stopping
          ? 'stopping'
          : this.childOnline
            ? 'running'
            : 'starting'
        : this.externalRunning
          ? 'running'
          : 'stopped',
      external: !this.child && this.externalRunning,
      autoStart: this.d.autoStart.get(),
      busy: this.busy,
      progress: this.progress,
      error: this.error,
    };
  }

  private emit(): void {
    this.d.onState(this.state());
  }

  // handle is the IPC entry point: one op from the SPA's bridge. It always
  // resolves, so error text reaches the page verbatim.
  async handle(op: unknown, arg: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const a = (arg && typeof arg === 'object' ? arg : {}) as Record<string, unknown>;
    const ops: Record<string, () => Promise<unknown>> = {
      getState: () => this.getState(),
      install: () => this.install(),
      beginConnect: () => this.beginConnect(),
      finishConnect: () => this.finishConnect(a.code),
      cancelConnect: () => this.cancelConnect(),
      start: () => this.start(),
      stop: () => this.stop(),
      setAutoStart: () => this.setAutoStart(a.on === true),
      disconnect: () => this.disconnect(),
      uninstall: () => this.uninstall(),
      readLog: async () => [...this.log],
    };
    const fn = typeof op === 'string' && Object.hasOwn(ops, op) ? ops[op] : null;
    if (!fn) return { ok: false, error: 'Unknown runner action.' };
    if (!this.d.supported && op !== 'getState') {
      return { ok: false, error: "This version of the ex app can't run ex-runner." };
    }
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }

  async getState(): Promise<RunnerState> {
    if (this.d.supported) {
      await this.refresh();
      // Best effort: the "update available" hint just doesn't show offline.
      void this.checkLatest().catch(() => {});
    }
    return this.state();
  }

  // ------------------------------------------------------------ discovery

  private async version(file: string): Promise<string | null> {
    try {
      await fs.access(file);
      const res = await this.d.run(file, ['--version'], this.childEnv());
      const v = res.stdout.trim();
      return res.code === 0 && v ? v : null;
    } catch {
      return null;
    }
  }

  private async findBinary(): Promise<RunnerManager['bin']> {
    const candidates = [this.d.binDir, ...this.d.searchDirs].map((dir) => path.join(dir, this.exe));
    for (const file of candidates) {
      const v = await this.version(file);
      if (v) return { path: file, version: v, source: file.startsWith(this.d.binDir + path.sep) ? 'app' : 'system' };
    }
    return null;
  }

  private canControl(): boolean {
    return !!this.bin && compareVersions(this.bin.version, MIN_CONTROLLABLE_VERSION) >= 0;
  }

  // refresh re-reads which ex-runner is installed and what `status --json`
  // says about its sign-in and whether one is running outside the app.
  async refresh(): Promise<void> {
    this.bin = await this.findBinary();
    this.connection = null;
    this.externalRunning = false;
    if (this.bin && this.canControl()) {
      try {
        const res = await this.d.run(this.bin.path, ['status', '--json'], this.childEnv());
        const st = JSON.parse(res.stdout) as Record<string, unknown>;
        const s = (k: string) => (typeof st[k] === 'string' ? (st[k] as string) : '');
        if (st.connected === true && s('server') && s('tokenId')) {
          this.connection = {
            server: s('server'),
            user: s('user'),
            label: s('label'),
            tokenId: s('tokenId'),
            expiresAt: s('expiresAt'),
            expired: st.expired === true,
          };
        }
        this.externalRunning = st.running === true && !this.child;
      } catch {
        // An unreadable status reads as "not connected": Connect fixes it.
      }
    }
    this.emit();
  }

  private async checkLatest(): Promise<string> {
    if (this.latest && this.now() - this.latest.at < LATEST_TTL_MS) return this.latest.version;
    const res = await this.d.fetch(RELEASES_API).catch(() => null);
    const body = res && res.ok ? ((await res.json().catch(() => null)) as { tag_name?: unknown } | null) : null;
    const tag = typeof body?.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
    if (!/^\d+(\.\d+)*$/.test(tag)) throw new Error("Couldn't find the latest ex-runner release. Check your connection.");
    const changed = this.latest?.version !== tag;
    this.latest = { version: tag, at: this.now() };
    if (changed) this.emit();
    return tag;
  }

  private childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...this.d.env,
      EX_RUNNER_HOME: this.d.home,
      PATH: augmentedPath(this.d.env, this.d.platform),
      ...extra,
    };
  }

  private guard(): void {
    if (this.busy) throw new Error('ex-runner is busy with something else — try again in a moment.');
  }

  private async work<T>(busy: RunnerBusy, fn: () => Promise<T>): Promise<T> {
    this.guard();
    this.busy = busy;
    this.error = null;
    this.emit();
    try {
      return await fn();
    } catch (err) {
      this.error = message(err);
      throw err;
    } finally {
      this.busy = null;
      this.progress = null;
      await this.refresh();
    }
  }

  // ------------------------------------------------------------- install

  // install downloads the newest release into the app's folder — also how
  // the app updates its own copy. A runner the app is running is stopped
  // for the swap and started again after.
  async install(): Promise<void> {
    await this.work('installing', async () => {
      const version = await this.checkLatest();
      const name = releaseAsset(version, this.d.platform, this.d.arch);
      if (!name) throw new Error(`ex-runner isn't available for this computer (${this.d.platform}/${this.d.arch}).`);
      const base = `${RELEASE_DOWNLOAD}/v${version}`;
      const sums = await this.d.fetch(`${base}/SHA256SUMS`);
      if (!sums.ok) throw new Error(`Couldn't download ex-runner ${version} (checksums: HTTP ${sums.status}).`);
      const want = (await sums.text())
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .find((p) => p[1] === `${name}.tar.gz`)?.[0];
      if (!want) throw new Error(`ex-runner ${version} has no download for this computer.`);

      const work = path.join(path.dirname(this.d.binDir), `install-${crypto.randomUUID()}`);
      await fs.mkdir(work, { recursive: true });
      try {
        const archive = path.join(work, `${name}.tar.gz`);
        const got = await this.download(`${base}/${name}.tar.gz`, archive);
        if (got !== want) throw new Error("The ex-runner download didn't match its checksum, so it wasn't installed.");
        const tar = await this.d.run('tar', ['-xzf', archive, '-C', work], this.d.env);
        if (tar.code !== 0) throw new Error(`Couldn't unpack ex-runner: ${lastLine(tar.stderr) || `tar exit ${tar.code}`}`);
        const unpacked = path.join(work, name, this.exe);
        await fs.access(unpacked);
        await fs.chmod(unpacked, 0o755);

        const wasRunning = !!this.child && this.bin?.source === 'app';
        if (wasRunning) await this.stopChild();
        await fs.mkdir(this.d.binDir, { recursive: true });
        await fs.rename(unpacked, path.join(this.d.binDir, this.exe));
        if (wasRunning) {
          await this.refresh();
          await this.spawnRunner();
        }
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    });
  }

  // download streams url into file, reporting progress, and returns the
  // SHA-256 of what it wrote.
  private async download(url: string, file: string): Promise<string> {
    const res = await this.d.fetch(url);
    if (!res.ok || !res.body) throw new Error(`Couldn't download ex-runner (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = await fs.open(file, 'w');
    let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await out.write(value);
        got += value.byteLength;
        if (total > 0) {
          this.progress = Math.min(1, got / total);
          this.emit();
        }
      }
    } finally {
      await out.close();
    }
    return hash.digest('hex');
  }

  // ------------------------------------------------------------- connect

  // beginConnect starts `ex-runner login --no-browser` and returns what the
  // SPA needs to approve it. A native dialog asks first: the page alone
  // must never be able to tie this computer to an account.
  async beginConnect(): Promise<ConnectRequest> {
    this.guard();
    const server = this.d.serverUrl();
    if (!server) throw new Error('Connect the app to a workspace first.');
    if (!this.bin || !this.canControl()) throw new Error('Install or update ex-runner first.');
    if (!(await this.d.confirmConnect(server))) throw new Error('cancelled');
    this.busy = 'connecting';
    this.error = null;
    this.emit();
    try {
      const proc = this.d.spawn(this.bin.path, ['login', '--no-browser', server], this.childEnv());
      let out = '';
      let err = '';
      const exited = new Promise<number>((resolve) => {
        proc.on('exit', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });
      const url = await new Promise<URL>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("ex-runner didn't start signing in. Try again.")),
          this.d.timeouts?.connectUrl ?? CONNECT_URL_TIMEOUT_MS,
        );
        proc.stdout?.on('data', (chunk) => {
          out += chunk.toString();
          const m = out.match(/https?:\/\/\S+\/runner\/connect\?\S+/);
          if (m) {
            clearTimeout(timer);
            resolve(new URL(m[0]));
          }
        });
        proc.stderr?.on('data', (chunk) => {
          err += chunk.toString();
        });
        void exited.then((code) => {
          clearTimeout(timer);
          reject(new Error(lastLine(err) || `ex-runner login exited (${code}).`));
        });
      });
      const q = url.searchParams;
      const port = Number(q.get('port'));
      if (url.origin !== new URL(server).origin || !(port >= 1024 && port <= 65535) || !q.get('state') || !q.get('challenge')) {
        proc.kill();
        throw new Error('ex-runner asked to connect somewhere unexpected, so nothing was connected.');
      }
      this.pending = { proc, port, state: q.get('state')!, exited };
      return { port, state: q.get('state')!, challenge: q.get('challenge')!, name: q.get('name') || 'this computer' };
    } catch (e) {
      this.busy = null;
      this.error = message(e);
      this.emit();
      throw e;
    }
  }

  // finishConnect hands the SPA's one-time code to the waiting runner and
  // waits for it to finish signing in.
  async finishConnect(code: unknown): Promise<void> {
    const p = this.pending;
    if (!p) throw new Error('No connection is waiting. Start again.');
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(code)) throw new Error('That sign-in code is invalid.');
    this.pending = null;
    try {
      const q = new URLSearchParams({ code, state: p.state });
      await this.d.httpGet(`http://127.0.0.1:${p.port}/callback?${q.toString()}`);
      const exit = await raceTimeout(p.exited, this.d.timeouts?.connectFinish ?? CONNECT_FINISH_TIMEOUT_MS, -1);
      if (exit !== 0) {
        p.proc.kill();
        throw new Error(exit === -1 ? 'ex-runner took too long to sign in.' : 'ex-runner could not finish signing in.');
      }
    } catch (e) {
      this.error = message(e);
      throw e;
    } finally {
      this.busy = null;
      await this.refresh();
    }
  }

  async cancelConnect(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (p) {
      const q = new URLSearchParams({ error: 'cancelled', state: p.state });
      await this.d.httpGet(`http://127.0.0.1:${p.port}/callback?${q.toString()}`).catch(() => {});
      p.proc.kill();
    }
    if (this.busy === 'connecting') {
      this.busy = null;
      this.emit();
    }
  }

  // ------------------------------------------------------------ run/stop

  async start(): Promise<void> {
    this.guard();
    if (this.child) return;
    if (this.externalRunning) throw new Error('ex-runner is already running on this computer.');
    if (!this.bin || !this.connection) throw new Error('Connect this computer first.');
    this.error = null;
    await this.spawnRunner();
  }

  private async spawnRunner(): Promise<void> {
    const child = this.d.spawn(this.bin!.path, ['start'], this.childEnv());
    this.child = child;
    this.childOnline = false;
    this.stopping = false;
    let errTail = '';
    const take = (chunk: Buffer | string, isErr: boolean) => {
      const text = chunk.toString();
      if (isErr) errTail = (errTail + text).slice(-2000);
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        this.log.push(line.trimEnd());
        if (ONLINE_LINE.test(line) && !this.childOnline && this.child === child) {
          this.childOnline = true;
          this.emit();
        }
      }
      if (this.log.length > LOG_LINES) this.log = this.log.slice(-LOG_LINES);
    };
    child.stdout?.on('data', (c) => take(c, false));
    child.stderr?.on('data', (c) => take(c, true));
    const done = (code: number | null) => {
      if (this.child !== child) return;
      const expected = this.stopping;
      this.child = null;
      this.childOnline = false;
      this.stopping = false;
      if (!expected) {
        this.error = `ex-runner stopped unexpectedly${code === null ? '' : ` (exit ${code})`}${lastLine(errTail) ? `: ${lastLine(errTail)}` : '.'}`;
      }
      void this.refresh();
    };
    child.on('exit', done);
    child.on('error', (e) => {
      errTail += e.message;
      done(null);
    });
    this.emit();
  }

  async stop(): Promise<void> {
    if (!this.child) {
      if (this.externalRunning) throw new Error('ex-runner is running outside the app — stop it there.');
      return;
    }
    await this.stopChild();
    this.error = null;
    await this.refresh();
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.emit();
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    child.kill('SIGTERM');
    const timedOut = await raceTimeout(
      exited.then(() => false),
      this.d.timeouts?.stop ?? STOP_TIMEOUT_MS,
      true,
    );
    if (timedOut) child.kill('SIGKILL');
    if (this.child === child) {
      this.child = null;
      this.childOnline = false;
      this.stopping = false;
    }
  }

  async setAutoStart(on: boolean): Promise<void> {
    this.d.autoStart.set(on);
    this.emit();
  }

  // ----------------------------------------------------- disconnect/remove

  async disconnect(): Promise<void> {
    await this.work('disconnecting', async () => {
      if (!this.bin) throw new Error('ex-runner is not installed.');
      await this.stopChild();
      const res = await this.d.run(this.bin.path, ['logout'], this.childEnv());
      if (res.code !== 0) throw new Error(lastLine(res.stderr) || 'ex-runner could not disconnect.');
    });
  }

  async uninstall(): Promise<void> {
    await this.work('removing', async () => {
      if (this.bin?.source !== 'app') throw new Error('Only the copy ex installed can be removed here.');
      await this.stopChild();
      await fs.rm(path.join(this.d.binDir, this.exe), { force: true });
    });
  }

  // shutdown is app quit and sign-out: a runner the app started stops with
  // it (one started outside the app is left alone), and a half-done login
  // is dropped. The signals go out before the first await — on quit, the
  // app does not wait for the rest.
  async shutdown(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    const stopped = this.stopChild();
    if (pending) {
      pending.proc.kill();
      this.busy = null;
    }
    await stopped;
    this.emit();
  }
}
