// Ex code workspace (plan-coding-agent.md): the fixed, user-visible folder
// where the coding agent keeps project checkouts — ~/ex-workspace by default
// (EX_WORKSPACE_ROOT overrides). One canonical clone per project, reused
// across tasks; a registry.json remembers what the agent learned about each
// project (default branch, setup/test/dev commands, port) so the next task
// skips the archaeology.
//
// Everything here is DETERMINISTIC runner code, not model behavior: clone or
// fetch, resolve the base branch, check out the task branch, report what
// happened. The credential never touches disk — git gets an inline
// credential helper through the environment of the child process only.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { RunnerLogger, TaskSpec, TaskSpecRepo } from './types';

const execFileP = promisify(execFile);

// Registry -----------------------------------------------------------------

export interface RegistryProject {
  dir: string;
  defaultBranch?: string;
  lastFetch?: string;
  setupCmd?: string;
  testCmd?: string;
  devCmd?: string;
  port?: number;
  notes?: string;
}

export interface Registry {
  version: 1;
  projects: Record<string, RegistryProject>;
}

export function workspaceRoot(): string {
  const override = process.env.EX_WORKSPACE_ROOT;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), 'ex-workspace');
}

function registryPath(root: string): string {
  return path.join(root, 'registry.json');
}

export function loadRegistry(root: string): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(root), 'utf8')) as Partial<Registry>;
    if (raw && raw.projects && typeof raw.projects === 'object') {
      return { version: 1, projects: raw.projects };
    }
  } catch {
    // first run / corrupt → empty
  }
  return { version: 1, projects: {} };
}

export function saveRegistry(root: string, reg: Registry): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(registryPath(root), JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

// repoDir is a repo's checkout inside its PROJECT folder:
// <root>/<projectKey>/<repoName>. Grouping by product keeps a task's repos
// side by side (the harness runs with the project folder as cwd) and reads
// naturally in Finder: ~/ex-workspace/cliffhub/{cliffhub-2-backend,…}.
// safeSegment keeps a folder name inside its parent: allowed characters
// only, and never "." / ".." (server-side validation already forbids these;
// this is the belt to that brace).
function safeSegment(s: string, fallback: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!clean || clean === '.' || clean === '..' || /^\.+$/.test(clean)) return fallback;
  return clean;
}

export function repoDir(root: string, projectKey: string, repoPath: string): string {
  const name = repoPath.split('/').filter(Boolean).pop() ?? '';
  return path.join(root, safeSegment(projectKey, 'project'), safeSegment(name, 'repo'));
}

export function projectDir(root: string, projectKey: string): string {
  return path.join(root, safeSegment(projectKey, 'project'));
}

// updateProjectCommands persists what the agent learned (register_project_commands).
export function updateProjectCommands(
  root: string,
  projectPath: string,
  cmds: Partial<Pick<RegistryProject, 'setupCmd' | 'testCmd' | 'devCmd' | 'port' | 'notes'>>,
): RegistryProject {
  const reg = loadRegistry(root);
  const cur: RegistryProject = reg.projects[projectPath] ?? { dir: projectDir(root, projectPath) };
  const next: RegistryProject = { ...cur };
  for (const k of ['setupCmd', 'testCmd', 'devCmd', 'notes'] as const) {
    const v = cmds[k];
    if (typeof v === 'string') {
      if (v.trim()) next[k] = v.trim().slice(0, 500);
      else delete next[k];
    }
  }
  if (typeof cmds.port === 'number' && Number.isFinite(cmds.port) && cmds.port > 0) next.port = Math.floor(cmds.port);
  reg.projects[projectPath] = next;
  saveRegistry(root, reg);
  return next;
}

// Git plumbing ---------------------------------------------------------------

export interface GitCred {
  // Origin of the GitLab instance, e.g. https://gitlab.example.com (no path).
  host: string;
  token: string; // personal access token; "" = anonymous
}

// gitHostFromBaseURL turns a connector base URL (…/api/v4) into the git origin.
export function gitHostFromBaseURL(baseURL: string): string {
  try {
    const u = new URL(baseURL);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

// gitEnv builds the child environment for git: no prompts ever, and — when a
// token is present — an inline credential helper that reads it from the
// child's own environment. Nothing is written to disk or to the repo config.
export function gitEnv(cred: GitCred | null, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
  if (cred && cred.token) {
    env.EX_GIT_TOKEN = cred.token;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.helper';
    env.GIT_CONFIG_VALUE_0 = '!f() { echo "username=oauth2"; echo "password=$EX_GIT_TOKEN"; }; f';
  }
  return env;
}

// Coverage: exempt through branchHasChanges — this stretch spawns real `git`
// processes against real remotes (clone/fetch/checkout/rev-list); its
// orchestration is only reachable from the excluded run.ts/mcp-server.ts, and
// the decisions around it (dir layout, branch naming, registry, env) are the
// covered helpers above (exemption agreed with Günter, 2026-09-22).
/* v8 ignore start */
export async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOk(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await git(args, cwd, env);
    return true;
  } catch {
    return false;
  }
}

// Workspace preparation -----------------------------------------------------

export interface PreparedRepo {
  path: string; // GitLab path
  role: string;
  dir: string;
  branch: string;
  baseBranch: string;
  cloned: boolean;
  headSha: string;
  baseSha: string;
  stashed: boolean;
  registry: RegistryProject;
  error?: string; // set when this repo could not be prepared (others may be fine)
}

export interface PrepareResult {
  projectDir: string; // cwd for the harness — the project folder holding every repo
  repos: PreparedRepo[];
  note: string; // the deterministic thread line
}

// prepareWorkspace makes every repo of the task ready inside the project
// folder: clone (or fetch), resolve the base branch, check out the task
// branch (creating it off the base on first use). Throws only when NO repo
// could be prepared; a partial failure is reported per repo so the agent can
// work on the rest and say what is missing.
export async function prepareWorkspace(
  task: TaskSpec,
  cred: GitCred | null,
  log: RunnerLogger,
  root = workspaceRoot(),
): Promise<PrepareResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.projectKey)) {
    throw new Error(`refusing to prepare a workspace for project key "${task.projectKey}"`);
  }
  if (!task.repos?.length) throw new Error('the task lists no repos');
  const pdir = projectDir(root, task.projectKey);
  fs.mkdirSync(pdir, { recursive: true });
  const repos: PreparedRepo[] = [];
  for (const r of task.repos) {
    try {
      repos.push(await prepareRepo(task, r, cred, log, root));
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log('workspace: repo preparation failed', { repo: r.path, error: why });
      repos.push({
        path: r.path, role: r.role, dir: repoDir(root, task.projectKey, r.path), branch: r.branch, baseBranch: r.baseBranch ?? '',
        cloned: false, headSha: '', baseSha: '', stashed: false, registry: { dir: repoDir(root, task.projectKey, r.path) }, error: why,
      });
    }
  }
  if (repos.every((r) => r.error)) {
    throw new Error(repos.map((r) => `${r.path}: ${r.error}`).join('; '));
  }
  const lines = repos.map((r) => {
    if (r.error) return `- ⚠️ ${r.path}: ${r.error}`;
    const where = shortenHome(r.dir);
    const how = r.cloned ? `cloned into \`${where}\`` : `reusing \`${where}\` (fetched)`;
    return `- ${r.path} (${r.role}): ${how}, origin/${r.baseBranch} @ ${r.baseSha}${r.stashed ? ' — earlier uncommitted changes were stashed' : ''}`;
  });
  const note = `📁 Workspace ready in \`${shortenHome(pdir)}\` on branch \`${task.repos[0].branch}\`:\n${lines.join('\n')}`;
  return { projectDir: pdir, repos, note };
}

async function prepareRepo(
  task: TaskSpec,
  r: TaskSpecRepo,
  cred: GitCred | null,
  log: RunnerLogger,
  root: string,
): Promise<PreparedRepo> {
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/.test(r.path) || r.path.includes('..')) {
    throw new Error(`refusing repo path "${r.path}"`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(r.branch) || r.branch.includes('..')) {
    throw new Error(`refusing branch name "${r.branch}"`);
  }
  let dir = repoDir(root, task.projectKey, r.path);
  // Checkouts made by the single-repo layout (<root>/<group>/…/<repo>) hold
  // work that was never pushed — keep using them rather than cloning afresh
  // and losing the branch.
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const legacy = path.join(root, ...r.path.split('/').filter((seg) => seg && seg !== '.' && seg !== '..'));
    if (legacy !== dir && fs.existsSync(path.join(legacy, '.git'))) {
      log('workspace: using legacy checkout location', { repo: r.path, dir: legacy });
      dir = legacy;
    }
  }
  const env = gitEnv(cred);
  const reg = loadRegistry(root);
  let cloned = false;

  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (!cred?.host) {
      throw new Error(`no checkout exists yet and no GitLab connector is installed — install the gitlab connector so I can clone`);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const url = `${cred.host.replace(/\/+$/, '')}/${r.path}.git`;
    log('workspace: cloning', { repo: r.path, dir });
    await git(['clone', '--depth', '50', '--no-single-branch', url, dir], path.dirname(dir), env, 15 * 60_000);
    cloned = true;
  } else {
    log('workspace: fetching', { repo: r.path, dir });
    try {
      await git(['fetch', 'origin', '--prune'], dir, env, 5 * 60_000);
    } catch (err) {
      // A reused checkout may still work offline (local-only history) — say
      // so instead of failing the task on a flaky network.
      log('workspace: fetch failed; continuing with local refs', { error: String(err) });
    }
  }

  // Base branch: the task's explicit base, else the remote HEAD, else the
  // usual suspects. Whatever we pick must exist on origin.
  let base = (r.baseBranch || '').trim();
  if (!base) {
    const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir, env).catch(() => '');
    if (head.startsWith('origin/')) base = head.slice('origin/'.length);
  }
  if (!base) {
    for (const cand of ['main', 'master', 'develop']) {
      if (await gitOk(['rev-parse', '--verify', `origin/${cand}`], dir, env)) {
        base = cand;
        break;
      }
    }
  }
  if (!base) throw new Error('could not determine the base branch — pass base_branch when creating the task');
  if (!(await gitOk(['rev-parse', '--verify', `origin/${base}`], dir, env))) {
    await git(['fetch', 'origin', base], dir, env, 5 * 60_000).catch(() => {});
    if (!(await gitOk(['rev-parse', '--verify', `origin/${base}`], dir, env))) {
      throw new Error(`base branch "${base}" does not exist on origin`);
    }
  }

  // Never clobber uncommitted work in a reused checkout: park it.
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, env).catch(() => '');
  let stashed = false;
  if (current !== r.branch) {
    const dirty = await git(['status', '--porcelain'], dir, env).catch(() => '');
    if (dirty) {
      await git(['stash', 'push', '-u', '-m', `ex-autostash before ${r.branch}`], dir, env);
      stashed = true;
    }
  }
  if (await gitOk(['rev-parse', '--verify', r.branch], dir, env)) {
    if (current !== r.branch) await git(['checkout', r.branch], dir, env);
  } else if (await gitOk(['rev-parse', '--verify', `origin/${r.branch}`], dir, env)) {
    // The branch already lives on origin (a previous machine pushed it).
    await git(['checkout', '-B', r.branch, `origin/${r.branch}`], dir, env);
  } else {
    await git(['checkout', '-B', r.branch, `origin/${base}`], dir, env);
  }
  const headSha = await git(['rev-parse', '--short', 'HEAD'], dir, env).catch(() => '');
  const baseSha = await git(['rev-parse', '--short', `origin/${base}`], dir, env).catch(() => '');

  const project: RegistryProject = { ...(reg.projects[r.path] ?? { dir }), dir, defaultBranch: base, lastFetch: new Date().toISOString() };
  reg.projects[r.path] = project;
  saveRegistry(root, reg);

  return { path: r.path, role: r.role, dir, branch: r.branch, baseBranch: base, cloned, headSha, baseSha, stashed, registry: project };
}

// branchHasChanges reports whether the task branch carries commits beyond
// its base — untouched repos get no MR.
export async function branchHasChanges(dir: string, base: string, cred: GitCred | null): Promise<boolean> {
  const env = gitEnv(cred);
  const n = await git(['rev-list', '--count', `origin/${base}..HEAD`], dir, env).catch(() => '0');
  return Number(n) > 0;
}
/* v8 ignore stop */

// shortenHome renders a path with ~ for the home dir — chat-friendly.
export function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// MR creation ----------------------------------------------------------------

export interface MergeRequestInput {
  host: string; // GitLab origin
  apiBase: string; // connector base URL (…/api/v4)
  token: string;
  projectPath: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  labels?: string[];
}

export interface MergeRequestResult {
  url: string;
  iid: number;
  existed: boolean;
}

// pushBranch pushes the task branch (sets upstream). Refuses a dirty tree —
// the agent must commit first; committing on its behalf would hide work.
// Coverage: exempt — runs real `git push` against a remote (see the git()
// exemption above).
/* v8 ignore start */
export async function pushBranch(dir: string, branch: string, cred: GitCred, log: RunnerLogger): Promise<string> {
  const env = gitEnv(cred);
  const dirty = await git(['status', '--porcelain'], dir, env);
  if (dirty) {
    throw new Error(`uncommitted changes in the workspace — commit them first:\n${dirty.split('\n').slice(0, 20).join('\n')}`);
  }
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, env);
  if (current !== branch) throw new Error(`HEAD is on ${current}, not the task branch ${branch}`);
  log('workspace: pushing', { dir, branch });
  await git(['push', '-u', 'origin', branch], dir, env, 5 * 60_000);
  return git(['rev-parse', '--short', 'HEAD'], dir, env);
}
/* v8 ignore stop */

// createMergeRequest opens (or finds) the MR for the branch via the GitLab
// API using the requester's own token — the MR author is the requester; the
// description carries the Ex signature.
export async function createMergeRequest(input: MergeRequestInput): Promise<MergeRequestResult> {
  const api = input.apiBase.replace(/\/+$/, '');
  const project = encodeURIComponent(input.projectPath);
  const headers = {
    authorization: `Bearer ${input.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  // Idempotent: an open MR for this branch is THE MR.
  const existing = await fetch(
    `${api}/projects/${project}/merge_requests?source_branch=${encodeURIComponent(input.sourceBranch)}&state=opened&per_page=1`,
    { headers },
  );
  if (existing.ok) {
    const rows = (await existing.json()) as { web_url?: string; iid?: number }[];
    if (Array.isArray(rows) && rows[0]?.web_url) {
      return { url: rows[0].web_url, iid: rows[0].iid ?? 0, existed: true };
    }
  }
  const res = await fetch(`${api}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      description: input.description,
      remove_source_branch: true,
      squash: false,
      ...(input.labels?.length ? { labels: input.labels.join(',') } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitLab refused the merge request (HTTP ${res.status}): ${text.slice(0, 600)}`);
  }
  const mr = JSON.parse(text) as { web_url?: string; iid?: number };
  if (!mr.web_url) throw new Error('GitLab returned no MR URL');
  return { url: mr.web_url, iid: mr.iid ?? 0, existed: false };
}

// Dev-server supervisor -----------------------------------------------------

export interface DevServerHandle {
  pid: number;
  logFile: string;
}

// One dev server per repo (backend + frontend); pid files are named so a
// re-publish restarts only its own server and a stop sweeps them all.
// Coverage: exempt through stopDevServer — spawns a real detached dev-server
// process and signals real process groups (exemption agreed with Günter,
// 2026-09-22).
/* v8 ignore start */
function pidFile(stateDir: string, name: string): string {
  return path.join(stateDir, `dev-${name.replace(/[^A-Za-z0-9._-]/g, '-') || 'server'}.pid`);
}

// startDevServer launches the project's dev command detached (own process
// group) so it outlives the run while the requester tests; stdout/err go to a
// log beside the runner state. A previous server for the same task is
// stopped first. Waits for the URL's port to accept connections.
export async function startDevServer(
  cmd: string,
  cwd: string,
  stateDir: string,
  url: string | undefined,
  log: RunnerLogger,
  name = 'server',
): Promise<DevServerHandle> {
  stopDevServer(stateDir, log, name);
  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, `dev-${name.replace(/[^A-Za-z0-9._-]/g, '-') || 'server'}.log`);
  const out = fs.openSync(logFile, 'a');
  const { spawn } = await import('node:child_process');
  const child = spawn(cmd, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, out],
    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
  });
  child.unref();
  fs.closeSync(out);
  if (!child.pid) throw new Error('dev server failed to start');
  fs.writeFileSync(pidFile(stateDir, name), String(child.pid), 'utf8');
  log('workspace: dev server started', { pid: child.pid, cmd });

  const port = portOf(url);
  if (port) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await portOpen(port)) return { pid: child.pid, logFile };
      await new Promise((r) => setTimeout(r, 1500));
    }
    const tail = tailFile(logFile, 1500);
    throw new Error(`dev server did not start listening on port ${port} within 90s. Log tail:\n${tail}`);
  }
  return { pid: child.pid, logFile };
}

// stopDevServer kills the recorded dev server(s): one by name, or every
// dev-*.pid in the state dir when no name is given.
export function stopDevServer(stateDir: string, log: RunnerLogger, name?: string): void {
  let files: string[];
  if (name) {
    files = [pidFile(stateDir, name)];
  } else {
    try {
      files = fs
        .readdirSync(stateDir)
        .filter((f) => /^dev-.*\.pid$/.test(f))
        .map((f) => path.join(stateDir, f));
    } catch {
      return;
    }
  }
  for (const file of files) {
    let pid: number;
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch {
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
    if (!pid) continue;
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
      log('workspace: dev server stopped', { pid, file: path.basename(file) });
    } catch {
      // already gone
    }
  }
}
/* v8 ignore stop */

export function portOf(url: string | undefined): number {
  if (!url) return 0;
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

// Coverage: exempt — opens real sockets; only used by the exempt dev-server
// start loop above.
/* v8 ignore start */
async function portOpen(port: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}
/* v8 ignore stop */

export function tailFile(file: string, bytes: number): string {
  try {
    const data = fs.readFileSync(file, 'utf8');
    return data.slice(-bytes);
  } catch {
    return '';
  }
}
