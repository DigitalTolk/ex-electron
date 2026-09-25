import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunnerApi, RunnerApiError, type RunnerIdentity } from '../src/runner/api';
import { setRunStatus } from '../src/runner/run-status';
import { turnsFor } from '../src/runner/types';

const id: RunnerIdentity = {
  runnerID: 'r1',
  host: 'mac',
  os: 'darwin',
  harnesses: [{ name: 'claude', version: '1', authed: true }],
};

function stubFetch(status: number, body?: unknown, text?: string) {
  const res = {
    status,
    ok: status >= 200 && status < 300,
    json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body)),
    text: () => Promise.resolve(text ?? ''),
  };
  const fn = vi.fn().mockResolvedValue(res);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('RunnerApi', () => {
  it('register posts the identity with the bearer token', async () => {
    const fetch = stubFetch(200, { runnerID: 'r1' });
    const api = new RunnerApi('https://ex.example', 'tok');
    await expect(api.register(id)).resolves.toEqual({ runnerID: 'r1' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://ex.example/api/v1/agent/runner/register');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string).runnerID).toBe('r1');
  });

  it('claim flattens harness names and turns an empty poll (204) into []', async () => {
    const fetch = stubFetch(204);
    const api = new RunnerApi('https://ex.example', 'tok');
    await expect(api.claim(id, 2, 20)).resolves.toEqual([]);
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({
      runnerID: 'r1',
      harnesses: ['claude'],
      max: 2,
      waitSec: 20,
    });
  });

  it('claim returns the assignments when the poll carries work', async () => {
    stubFetch(200, { assignments: [{ runID: 'run1' }] });
    const api = new RunnerApi('https://ex.example', 'tok');
    await expect(api.claim(id, 1, 20)).resolves.toEqual([{ runID: 'run1' }]);
    // A body without the field still yields [].
    stubFetch(200, {});
    await expect(api.claim(id, 1, 20)).resolves.toEqual([]);
  });

  it('surfaces backend errors as RunnerApiError with the server code', async () => {
    stubFetch(401, { error: 'token_revoked', message: 'runner token revoked' });
    const api = new RunnerApi('https://ex.example', 'tok');
    const err = await api.heartbeat(id, ['run1']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerApiError);
    expect((err as RunnerApiError).status).toBe(401);
    expect((err as RunnerApiError).code).toBe('token_revoked');
    expect((err as RunnerApiError).message).toBe('runner token revoked');
  });

  it('keeps the default code for a non-JSON error body and partial JSON', async () => {
    stubFetch(502);
    const api = new RunnerApi('https://ex.example', 'tok');
    let err = (await api.fail('r1', 'run1', 'boom').catch((e: unknown) => e)) as RunnerApiError;
    expect(err.code).toBe('http_error');
    expect(err.message).toBe('502');
    stubFetch(500, {});
    err = (await api.complete('r1', 'run1', 'done', { inputTokens: 1, outputTokens: 2 }).catch((e: unknown) => e)) as RunnerApiError;
    expect(err.code).toBe('http_error');
    expect(err.message).toBe('500');
  });

  it('events posts the batch to the run-scoped path', async () => {
    const fetch = stubFetch(200, { kill: false });
    const api = new RunnerApi('https://ex.example', 'tok');
    await expect(api.events('r1', 'run9', [{ kind: 'turn' } as never])).resolves.toEqual({ kill: false });
    expect(fetch.mock.calls[0][0]).toBe('https://ex.example/api/v1/agent/runner/runs/run9/events');
  });
});

describe('setRunStatus', () => {
  it('POSTs the state over the run token and tolerates success', async () => {
    const fetch = stubFetch(200, {});
    await setRunStatus('https://ex.example', 'run-tok', 'working');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://ex.example/api/v1/agent/run/state');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer run-tok');
    expect(JSON.parse(init.body as string)).toEqual({ state: 'working' });
  });

  it('throws on a refused status so callers can log it', async () => {
    stubFetch(403);
    await expect(setRunStatus('https://ex.example', 'run-tok', 'working')).rejects.toThrow('set status failed: 403');
  });
});

describe('turnsFor', () => {
  const limits = { maxTurns: 10, maxTaskTurns: 40 } as never;
  it('gives coding tasks no cap, direct chats depth, ambient modes the short budget', () => {
    expect(turnsFor(limits, 'task')).toBe(0);
    expect(turnsFor(limits, 'direct')).toBe(40);
    expect(turnsFor(limits, undefined)).toBe(40);
    expect(turnsFor(limits, 'watch')).toBe(10);
  });
  it('falls back to platform defaults when limits carry zeros', () => {
    expect(turnsFor({ maxTurns: 0, maxTaskTurns: 0 } as never, 'direct')).toBe(128);
    expect(turnsFor({ maxTurns: 0, maxTaskTurns: 0 } as never, 'heartbeat')).toBe(16);
  });
});
