import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMergeRequest,
  gitEnv,
  gitHostFromBaseURL,
  loadRegistry,
  portOf,
  projectDir,
  repoDir,
  saveRegistry,
  shortenHome,
  tailFile,
  updateProjectCommands,
  workspaceRoot,
  type MergeRequestInput,
} from '../src/runner/workspace';

let tmp: string;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('workspace registry', () => {
  it('starts empty and round-trips project facts', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-ws-'));
    expect(loadRegistry(tmp).projects).toEqual({});
    const next = updateProjectCommands(tmp, 'dt/booking-portal', { testCmd: 'npm test', devCmd: 'npm run dev', port: 5273 });
    expect(next.dir).toBeTruthy();
    expect(loadRegistry(tmp).projects['dt/booking-portal']).toMatchObject({ testCmd: 'npm test', devCmd: 'npm run dev', port: 5273 });
    // Empty string clears; other fields survive.
    updateProjectCommands(tmp, 'dt/booking-portal', { devCmd: '' });
    const after = loadRegistry(tmp).projects['dt/booking-portal'];
    expect(after.devCmd).toBeUndefined();
    expect(after.testCmd).toBe('npm test');
  });

  it('survives a corrupt file', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-ws-'));
    fs.writeFileSync(path.join(tmp, 'registry.json'), '{not json');
    expect(loadRegistry(tmp).projects).toEqual({});
    saveRegistry(tmp, { version: 1, projects: {} });
    expect(loadRegistry(tmp).projects).toEqual({});
  });

  it('lays repos out per PRODUCT and never escapes the root', () => {
    expect(projectDir('/root', 'cliffhub')).toBe(path.join('/root', 'cliffhub'));
    expect(repoDir('/root', 'cliffhub', 'acme/web/cliffhub-2-frontend')).toBe(
      path.join('/root', 'cliffhub', 'cliffhub-2-frontend'),
    );
    expect(repoDir('/root', 'cliffhub', 'dt/../../etc')).toBe(path.join('/root', 'cliffhub', 'etc'));
    expect(repoDir('/root', 'cliffhub', '//')).toBe(path.join('/root', 'cliffhub', 'repo'));
    expect(projectDir('/root', '..')).toBe(path.join('/root', 'project'));
    expect(repoDir('/root', 'cliffhub', 'group/..')).toBe(path.join('/root', 'cliffhub', 'repo'));
  });
});

describe('git plumbing', () => {
  it('derives the git origin from a connector base URL', () => {
    expect(gitHostFromBaseURL('https://gitlab.example.com/api/v4')).toBe('https://gitlab.example.com');
    expect(gitHostFromBaseURL('not a url')).toBe('');
  });

  it('injects an inline credential helper via env only when a token exists', () => {
    const withTok = gitEnv({ host: 'https://gitlab.example.com', token: 'glpat-x' });
    expect(withTok.GIT_TERMINAL_PROMPT).toBe('0');
    expect(withTok.EX_GIT_TOKEN).toBe('glpat-x');
    expect(withTok.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(withTok.GIT_CONFIG_VALUE_0).toContain('username=oauth2');
    // The token itself never appears in the helper text (it is read from env).
    expect(withTok.GIT_CONFIG_VALUE_0).not.toContain('glpat-x');
    const anon = gitEnv(null);
    expect(anon.GIT_CONFIG_COUNT).toBeUndefined();
    expect(anon.EX_GIT_TOKEN).toBeUndefined();
  });

  it('reads the port out of a test URL', () => {
    expect(portOf('http://localhost:5273/bookings')).toBe(5273);
    expect(portOf('http://localhost/')).toBe(80);
    expect(portOf('https://app.example.net/x')).toBe(443);
    expect(portOf(undefined)).toBe(0);
    expect(portOf('nope')).toBe(0);
  });
});

describe('path rendering helpers', () => {
  it('workspaceRoot honors the env override and defaults under home', () => {
    const prev = process.env.EX_WORKSPACE_ROOT;
    try {
      process.env.EX_WORKSPACE_ROOT = '/custom/ws';
      expect(workspaceRoot()).toBe(path.resolve('/custom/ws'));
      process.env.EX_WORKSPACE_ROOT = '   ';
      expect(workspaceRoot()).toBe(path.join(os.homedir(), 'ex-workspace'));
      delete process.env.EX_WORKSPACE_ROOT;
      expect(workspaceRoot()).toBe(path.join(os.homedir(), 'ex-workspace'));
    } finally {
      if (prev === undefined) delete process.env.EX_WORKSPACE_ROOT;
      else process.env.EX_WORKSPACE_ROOT = prev;
    }
  });

  it('shortenHome swaps the home prefix for ~ and leaves other paths alone', () => {
    expect(shortenHome(path.join(os.homedir(), 'ex-workspace', 'x'))).toBe(path.join('~', 'ex-workspace', 'x'));
    expect(shortenHome('/etc/hosts')).toBe('/etc/hosts');
  });

  it('tailFile returns the last bytes of a file, or empty when unreadable', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-ws-'));
    const f = path.join(tmp, 'dev.log');
    fs.writeFileSync(f, 'abcdefghij');
    expect(tailFile(f, 4)).toBe('ghij');
    expect(tailFile(path.join(tmp, 'absent.log'), 4)).toBe('');
  });
});

describe('createMergeRequest', () => {
  const input: MergeRequestInput = {
    host: 'https://gitlab.example.com',
    apiBase: 'https://gitlab.example.com/api/v4/',
    token: 'glpat-x',
    projectPath: 'dt/booking-portal',
    sourceBranch: 'ex/task-1',
    targetBranch: 'main',
    title: 'fix: leap year',
    description: 'via ex',
  };

  afterEach(() => vi.unstubAllGlobals());

  const stub = (responses: { ok: boolean; status?: number; body?: unknown; text?: string }[]) => {
    const fn = vi.fn();
    for (const r of responses) {
      fn.mockResolvedValueOnce({
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: () => Promise.resolve(r.body),
        text: () => Promise.resolve(r.text ?? JSON.stringify(r.body ?? {})),
      });
    }
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('finds an open MR for the branch and reuses it', async () => {
    const fetch = stub([{ ok: true, body: [{ web_url: 'https://gl/mr/7', iid: 7 }] }]);
    await expect(createMergeRequest(input)).resolves.toEqual({ url: 'https://gl/mr/7', iid: 7, existed: true });
    stub([{ ok: true, body: [{ web_url: 'https://gl/mr/7' }] }]);
    await expect(createMergeRequest(input)).resolves.toEqual({ url: 'https://gl/mr/7', iid: 0, existed: true });
    // Trailing slash on apiBase is normalized; the branch is URL-encoded.
    expect(fetch.mock.calls[0][0]).toContain('/api/v4/projects/dt%2Fbooking-portal/merge_requests?source_branch=ex%2Ftask-1');
  });

  it('creates the MR when none is open, with labels when given', async () => {
    const fetch = stub([
      { ok: true, body: [] },
      { ok: true, text: JSON.stringify({ web_url: 'https://gl/mr/8', iid: 8 }) },
    ]);
    const res = await createMergeRequest({ ...input, labels: ['ex', 'bot'] });
    expect(res).toEqual({ url: 'https://gl/mr/8', iid: 8, existed: false });
    const body = JSON.parse(fetch.mock.calls[1][1].body as string);
    expect(body.labels).toBe('ex,bot');
    expect(body.remove_source_branch).toBe(true);
  });

  it('still creates when the lookup itself fails, and defaults iid to 0', async () => {
    stub([
      { ok: false, status: 500, text: 'boom' },
      { ok: true, text: JSON.stringify({ web_url: 'https://gl/mr/9' }) },
    ]);
    await expect(createMergeRequest(input)).resolves.toEqual({ url: 'https://gl/mr/9', iid: 0, existed: false });
  });

  it('surfaces a refused create with the response text, and a missing URL', async () => {
    stub([
      { ok: true, body: [{}] },
      { ok: false, status: 409, text: 'branch conflict' },
    ]);
    await expect(createMergeRequest(input)).rejects.toThrow('GitLab refused the merge request (HTTP 409): branch conflict');
    stub([
      { ok: true, body: 'not-an-array' },
      { ok: true, text: JSON.stringify({ iid: 3 }) },
    ]);
    await expect(createMergeRequest(input)).rejects.toThrow('GitLab returned no MR URL');
  });
});
