// HTTP client for the ex backend's runner API. Outbound HTTPS only — the
// desktop never listens (plan-v2 §2). No Electron imports: this module (and
// everything under src/runner/) must stay extractable into a headless
// ex-agentd later.
import type {
  Assignment,
  EventsResponse,
  HeartbeatResponse,
  RegisterResponse,
  RunEventInput,
  RunnerHarness,
} from './types';

export class RunnerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RunnerIdentity {
  runnerID: string;
  host: string;
  os: string;
  harnesses: RunnerHarness[];
}

export class RunnerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      // Every runner call today carries a body; the undefined arm is kept for
      // a future GET and exempted rather than exercised artificially.
      /* v8 ignore next */
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      let code = 'http_error';
      let message = `${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string; message?: string };
        code = parsed.error ?? code;
        message = parsed.message ?? message;
      } catch {
        // non-JSON error body — keep defaults
      }
      throw new RunnerApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }

  register(id: RunnerIdentity): Promise<RegisterResponse> {
    return this.call('POST', '/api/v1/agent/runner/register', id);
  }

  // Long-poll for work; resolves to [] on a 204 empty poll.
  async claim(id: RunnerIdentity, max: number, waitSec: number): Promise<Assignment[]> {
    const res = await this.call<{ assignments: Assignment[] } | undefined>(
      'POST',
      '/api/v1/agent/runner/claim',
      {
        runnerID: id.runnerID,
        harnesses: id.harnesses.map((h) => h.name),
        max,
        waitSec,
      },
    );
    return res?.assignments ?? [];
  }

  heartbeat(id: RunnerIdentity, activeRunIDs: string[]): Promise<HeartbeatResponse> {
    return this.call('POST', '/api/v1/agent/runner/heartbeat', { ...id, activeRunIDs });
  }

  // Report a batch; the response tells us whether to kill the harness.
  events(runnerID: string, runID: string, events: RunEventInput[]): Promise<EventsResponse> {
    return this.call('POST', `/api/v1/agent/runner/runs/${runID}/events`, { runnerID, events });
  }

  complete(
    runnerID: string,
    runID: string,
    finalText: string,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    return this.call('POST', `/api/v1/agent/runner/runs/${runID}/complete`, {
      runnerID,
      finalText,
      usage,
    });
  }

  fail(runnerID: string, runID: string, reason: string): Promise<void> {
    return this.call('POST', `/api/v1/agent/runner/runs/${runID}/fail`, { runnerID, reason });
  }
}
