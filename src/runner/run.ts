// Per-assignment execution: scratch dir, MCP config, harness spawn, event
// pump, and the local (advisory) limit enforcement. The backend re-enforces
// every bound authoritatively (plan-v2 §9).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RunnerApi } from './api';
import { EMPTY_CONNECTOR_SETUP, fetchRunConnectors, syncConnectors } from './connectors';
import type { ConnectorSetup } from './connectors';
import { setRunStatus } from './run-status';
import type { DetectedHarness } from './detect';
import { runBedrock } from './harness/bedrock';
import { runClaude } from './harness/claude';
import { runCodex } from './harness/codex';
import { runHasConnectors, systemRules } from './harness/shared';
import type { RunningHarness } from './harness/shared';
import { addSessionCost, dropSession, getSession, putSession, sessionWorkDir, threadKey } from './sessions';
import type { Assignment, RunEventInput, RunnerLogger, RunOutcome } from './types';
import { gitHostFromBaseURL, loadRegistry, prepareWorkspace, shortenHome, workspaceRoot } from './workspace';
import type { GitCred, PrepareResult, Registry } from './workspace';

const EVENT_FLUSH_MS = 1000;
const EVENT_FLUSH_COUNT = 20;

// clipToolInput keeps the drawer-relevant fields of a harness tool call,
// each bounded, so the timeline can render commands, file chips and diffs
// without storing whole files.
export function clipToolInput(name: string, input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const s = (k: string, n: number): string | undefined => {
    const v = input[k];
    if (typeof v !== 'string') return undefined;
    return v.length > n ? `${v.slice(0, n)}…` : v;
  };
  const base = name.replace(/^mcp__ex__/, '');
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown): void => {
    if (v !== undefined && v !== '') out[k] = v;
  };
  switch (base) {
    case 'Bash':
    case 'shell':
      put('command', s('command', 2000));
      put('description', s('description', 200));
      break;
    case 'Edit':
    case 'MultiEdit':
      put('file_path', s('file_path', 400));
      put('old_string', s('old_string', 2500));
      put('new_string', s('new_string', 2500));
      break;
    case 'Write':
      put('file_path', s('file_path', 400));
      put('content', s('content', 2500));
      break;
    case 'Read':
      put('file_path', s('file_path', 400));
      if (typeof input.offset === 'number') put('offset', input.offset);
      if (typeof input.limit === 'number') put('limit', input.limit);
      break;
    case 'Glob':
    case 'Grep':
      put('pattern', s('pattern', 300));
      put('path', s('path', 400));
      break;
    case 'WebFetch':
      put('url', s('url', 400));
      break;
    case 'WebSearch':
      put('query', s('query', 300));
      break;
    default: {
      let raw: string;
      try {
        raw = JSON.stringify(input);
      } catch {
        raw = '';
      }
      if (raw) put('json', raw.length > 800 ? `${raw.slice(0, 800)}…` : raw);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ExecuteDeps {
  api: RunnerApi;
  runnerID: string;
  baseUrl: string;
  // Root of the Ex code workspace for coding tasks (~/ex-workspace default;
  // the desktop app's "Code workspace folder" setting).
  workspaceRoot?: string;
  harnesses: DetectedHarness[];
  searchPath: string;
  // How the harness should spawn the MCP server: the Electron binary running
  // our bundled dist/mcp-server.js as plain Node (ELECTRON_RUN_AS_NODE) so we
  // never depend on a system Node install.
  mcpEntry: { command: string; args: string[] };
  // Hands the caller a kill switch for the spawned harness the moment it
  // exists — the heartbeat's kill list needs to terminate a WEDGED harness,
  // and a wedged harness by definition isn't calling home to hear "abort".
  onHarness?: (runID: string, kill: (reason: string) => void) => void;
  // stateDir enables warm claude sessions (per-thread session cache + stable
  // working dirs live under it). Absent → every run is cold.
  stateDir?: string;
  log: RunnerLogger;
}

// eventPump batches runner events toward the backend. Each event carries a
// monotonic seq (idempotent server-side); an abort response kills the run.
class eventPump {
  private buf: RunEventInput[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;

  constructor(
    private readonly deps: ExecuteDeps,
    private readonly runID: string,
    private readonly onAbort: (reason: string) => void,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), EVENT_FLUSH_MS);
  }

  push(type: RunEventInput['type'], payload?: Record<string, unknown>): void {
    this.seq += 1;
    this.buf.push({ seq: this.seq, type, payload });
    if (this.buf.length >= EVENT_FLUSH_COUNT) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.sending || this.buf.length === 0) return;
    this.sending = true;
    const batch = this.buf;
    this.buf = [];
    try {
      const res = await this.deps.api.events(this.deps.runnerID, this.runID, batch);
      if (res.abort) this.onAbort(res.reason ?? 'aborted');
    } catch (err) {
      // Re-queue in order for the next tick — seqs make the retry idempotent.
      this.buf = [...batch, ...this.buf];
      this.deps.log('event batch failed; will retry', { runID: this.runID, error: String(err) });
    } finally {
      this.sending = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

// watchPreamble frames a watcher run: the creator's standing order plus the
// action mode, which caps what the agent may DO. notify/draft are also
// enforced server-side (public posts are rejected), but stating it keeps the
// model from wasting a turn attempting one.
function watchPreamble(a: Assignment): string {
  const mode = a.actionMode || 'notify';
  const order = (a.watchInstruction || '').trim();
  let p =
    '[watcher] You are running as a WATCHER for ' +
    a.invokerName +
    ', triggered by new activity below — NOT a mention. First decide if this activity actually ' +
    'matches what you were asked to watch for; if not, end WITHOUT doing anything (the normal outcome).\n';
  if (order) p += `\n# Standing order from ${a.invokerName}\n${order}\n`;
  // Gated modes are deterministic: the agent has NO communication tools. It
  // reads context, then its FINAL MESSAGE is the deliverable — the system
  // routes that text by mode. So the prompt tells it what to write and where
  // it will go, never which tool to call. To opt out (activity doesn't match
  // the standing order), the agent replies with exactly SKIP and nothing is
  // delivered. Only autonomous keeps posting tools.
  const skip =
    'If this activity does NOT match the standing order, reply with exactly `SKIP` and nothing ' +
    'else — nothing will be sent. ';
  const actions: Record<string, string> = {
    notify:
      '\n# Action mode: NOTIFY (deterministic). You have no posting or messaging tools. ' +
      'Read what you need, then your FINAL MESSAGE becomes a private DM to ' +
      a.invokerName +
      ' — a short heads-up of what matched and why it matters. ' +
      skip +
      'Do not address the channel; write it as a note to your creator.\n',
    draft:
      '\n# Action mode: DRAFT (deterministic). You have no posting or messaging tools. ' +
      'Read what you need, then your FINAL MESSAGE becomes a private DM to ' +
      a.invokerName +
      ' containing a ready-to-send reply they can copy and post themselves. Write only the reply ' +
      'text, as they would send it. ' +
      skip +
      '\n',
    reply:
      '\n# Action mode: REPLY (deterministic). You have no posting tools. ' +
      'Read what you need, then your FINAL MESSAGE becomes the reply text — the system shows it to ' +
      a.invokerName +
      ' as an editable draft to approve, edit, or cancel, and posts it on approval. Write only the ' +
      'reply itself, exactly as it should appear in the thread. ' +
      skip +
      '\n',
    autonomous:
      '\n# Action mode: AUTONOMOUS. You may post publicly on your creator\'s behalf without asking. ' +
      'Be conservative and act only when it clearly serves the standing order; use notify_owner ' +
      'when a private heads-up is more appropriate than a public reply.\n',
  };
  p += actions[mode] ?? actions.notify;
  return p + '\n';
}

// modePreamble frames watch/heartbeat runs: ambient invocations must be
// conservative — silence is the default success.
function modePreamble(a: Assignment): string {
  switch (a.mode) {
    case 'watch':
      return watchPreamble(a);
    case 'heartbeat':
      return '[periodic check-in] ';
    case 'followup': {
      // Keep follow-ups CHEAP: decide relevance first, before any tool use.
      let p =
        '[thread follow-up] Your invoker replied in a thread you took part in, WITHOUT tagging ' +
        'you. FIRST decide, before calling any tool: does this reply actually need you — a ' +
        'question aimed at you, a correction, new information that changes your earlier answer? ' +
        'If not, end immediately without posting; that is the normal outcome. If you do reply, ' +
        'keep it to a sentence or two.\n';
      if (a.askFirst) {
        p +=
          'Your invoker requires confirmation before follow-up replies: once you know what you ' +
          'would say, call request_approval with a one-line summary of your reply and post ONLY ' +
          'if approved.\n';
      }
      return p + '\n';
    }
    default:
      return '';
  }
}

// taskPreamble frames a coding-task run: the machine-local workspace facts
// the server cannot know (checkout path, what the registry remembers) plus
// the rules of engagement. Everything the SERVER knows about the task rides
// the context bundle's "# Coding task" section instead.
function taskPreamble(a: Assignment, prep: PrepareResult, reg: Registry): string {
  const t = a.task;
  if (!t) return '';
  const cmd = (v: string | undefined): string => (v ? `\`${v}\`` : 'unknown — discover it, then register_project_commands');
  const repoLines = prep.repos.map((r) => {
    if (r.error) return `- ${r.path} (${r.role}): NOT AVAILABLE — ${r.error}. Say so in the thread; do not improvise a replacement.`;
    const p = reg.projects[r.path];
    return (
      `- ${r.path} (${r.role}): ${r.dir} — branch ${r.branch} (base origin/${r.baseBranch}), ${r.cloned ? 'fresh clone' : 'reused checkout, fetched'}. ` +
      `Known commands: setup ${cmd(p?.setupCmd)}; test ${cmd(p?.testCmd)}; dev server ${cmd(p?.devCmd)}${p?.port ? ` on port ${p.port}` : ''}.${p?.notes ? ` Notes: ${p.notes}` : ''}`
    );
  });
  const hasFrontend = prep.repos.some((r) => r.role === 'frontend' && !r.error);
  return [
    `[coding task] You are working on ${t.kind} "${t.title}" for ${t.projectName} on behalf of ${a.invokerName}.`,
    '',
    '# Workspace (this machine)',
    `- Project folder: ${prep.projectDir} — your working directory; every repo below is a subfolder. Every file path and command stays inside it.`,
    ...repoLines,
    `- Permissions: edits and routine commands inside the project folder (package managers, tests, linters, docker compose, local git add/commit) run WITHOUT approval; anything outside it, network beyond connectors, git push, and destructive commands ask ${a.invokerName}. Never git push yourself — request_mr does that after sign-off, for every repo you changed.`,
    '- Commits: per repo, small and focused, clear messages, trailer `Co-authored-by: dev (Ex coding agent) <dev@ex.local>`. Cross-repo changes (API + UI) ship together as one task.',
    hasFrontend
      ? '- The product has a UI: it lives in the frontend repo above. UI work happens THERE — never build a standalone page/app from scratch, never hand the requester an API URL to test.'
      : '- No frontend repo is on this task. If the change needs UI work, stop and ask which frontend repo to add (ask_user / task_state) — never build a UI from scratch.',
    '- Understand how the product works end to end before changing it: how it starts (docker compose if the repo ships one), how people sign in, which roles see what.',
    `- When the change is verified locally: publish_test_plan — start the product the way ${a.invokerName} uses it (pass the dev commands so the runner keeps the servers running), give the URL to OPEN, numbered steps from ${a.invokerName}'s perspective (who to sign in as, what to click, what they should see), and counter-checks (what must NOT happen, who must NOT see it, what must still work as before). Then END your turn; replies in the thread resume you.`,
    '- Budget: this run has no turn or time cap; it ends when you end your turn, or after 15 minutes of silence. Keep working or finish — never stall.',
    '',
  ].join('\n');
}

// gitlabCred picks the gitlab connector out of the run's connector rows — the
// clone/push credential and the MR API token, never written to disk.
function gitlabCred(rows: { slug: string; baseURL: string; token: string }[]): GitCred | null {
  const gl = rows.find((r) => r.slug === 'gitlab');
  if (!gl) return null;
  return { host: gitHostFromBaseURL(gl.baseURL), token: gl.token };
}

// infraFailure: failures worth one retry — the CLI never started or died
// abnormally. Model/task failures and deliberate kills are not retried.
function infraFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith('spawn_failed') || /^harness_exit_/.test(reason);
}

// executeAssignment runs one claimed task to completion and reports the
// outcome. Never throws — every failure path lands in api.fail.
//
// Claude and codex runs get warm sessions: round N of a conversation resumes
// round N-1's session (per agent+thread) with a compact delta prompt instead
// of cold-starting and re-sending the whole bundle. A failed resume falls back
// to a fresh session; infra failures get one retry (buzz-style, minus the
// dead-letter queue — the backend's run ledger is our dead letter).
export async function executeAssignment(a: Assignment, deps: ExecuteDeps): Promise<void> {
  const harness = deps.harnesses.find((h) => h.name === a.harness);
  if (!harness) {
    await deps.api.fail(deps.runnerID, a.runID, `harness_missing:${a.harness}`).catch(() => {});
    return;
  }

  const canResume = (a.harness === 'claude' || a.harness === 'codex') && !!deps.stateDir;
  let session = canResume ? getSession(a) : null;
  // Sessions are bound to their cwd (claude ties sessions to it; codex keeps
  // its rollout in the per-thread CODEX_HOME inside it) — a resumable thread
  // keeps a stable workDir; everything else gets a swept temp dir.
  const tmpDir = session || canResume ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'ex-run-'));
  const workDir =
    tmpDir ?? (canResume ? sessionWorkDir(deps.stateDir ?? '', threadKey(a)) : fs.mkdtempSync(path.join(os.tmpdir(), 'ex-run-')));

  let running: RunningHarness | null = null;
  const pump = new eventPump(deps, a.runID, (reason) => {
    deps.log('backend ordered abort', { runID: a.runID, reason });
    running?.kill(`abort:${reason}`);
  });

  // Local wall-clock fast-fail (authoritative deadline lives server-side).
  // Task runs carry a far horizon that overflows setTimeout's 32-bit delay —
  // Node would clamp it to 1ms and kill the run instantly — so only arm the
  // timer for delays it can actually represent.
  const deadlineMs = new Date(a.deadline).getTime() - Date.now();
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  if (Number.isFinite(deadlineMs) && deadlineMs < 2_147_000_000) {
    deadlineTimer = setTimeout(() => running?.kill('deadline'), Math.max(deadlineMs, 1000));
    deadlineTimer.unref();
  }

  // Connectors: only when the invoking message explicitly picked services
  // with /slug tokens (the server adds gitlab to coding-task runs). A
  // fetch/sync failure downgrades to "no connectors" rather than failing the
  // run — the agent just works without API access.
  let connectorSetup: ConnectorSetup = EMPTY_CONNECTOR_SETUP;
  let gitCred: GitCred | null = null;
  if (a.connectorSlugs?.length) {
    try {
      const rows = await fetchRunConnectors(deps.baseUrl, a.mcpToken);
      connectorSetup = syncConnectors(path.join(workDir, 'connectors'), rows, deps.log);
      gitCred = gitlabCred(rows);
    } catch (err) {
      deps.log('connector sync failed; continuing without', { runID: a.runID, error: String(err) });
    }
  }

  // Coding task: prepare the project checkout BEFORE the harness starts —
  // clone or fetch, base branch, task branch — and narrate it in the task
  // thread through the run token. The harness then runs INSIDE the checkout
  // (cwd) while our per-run files stay in workDir.
  let taskCwd: string | undefined;
  let taskText = '';
  let taskRepos: { path: string; role: string; dir: string; branch: string; base: string }[] = [];
  if (a.task) {
    const report = (body: Record<string, unknown>): Promise<void> =>
      fetch(`${deps.baseUrl}/api/v1/agent/run/coding-task/report`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.mcpToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(() => undefined)
        .catch((err: unknown) => deps.log('task report failed', { runID: a.runID, error: String(err) }));
    try {
      const root = deps.workspaceRoot || workspaceRoot();
      const prep = await prepareWorkspace(a.task, gitCred, deps.log, root);
      taskCwd = prep.projectDir;
      taskRepos = prep.repos.filter((r) => !r.error).map((r) => ({ path: r.path, role: r.role, dir: r.dir, branch: r.branch, base: r.baseBranch }));
      taskText = taskPreamble(a, prep, loadRegistry(root));
      // First run announces the workspace; later runs only re-pin the facts
      // silently (a fetch happened, nothing to say). A partially failed
      // preparation is always announced.
      const partial = prep.repos.some((r) => r.error);
      const first = a.task.state === 'created' || a.task.state === 'setup_failed';
      await report({
        state: first ? 'workspace_ready' : '',
        note: first || partial ? prep.note : '',
        repos: prep.repos
          .filter((r) => !r.error)
          .map((r) => ({ path: r.path, branch: r.branch, base_branch: r.baseBranch, workspace_dir: shortenHome(r.dir) })),
      });
    } catch (err) {
      const why = String(err instanceof Error ? err.message : err);
      deps.log('workspace preparation failed', { runID: a.runID, error: why });
      await report({ state: 'setup_failed', note: `⚠️ Couldn't prepare the workspace: ${why.slice(0, 1500)}` });
      await deps.api.fail(deps.runnerID, a.runID, `workspace_failed: ${why.slice(0, 300)}`).catch(() => {});
      if (deadlineTimer) clearTimeout(deadlineTimer);
      return;
    }
  }

  // Preamble order: the coding-task workspace frame, then the run's mode
  // frame (watcher/follow-up), then the connected-services priority block —
  // all ride the top of the prompt so they outrank everything in the bundle.
  const preamble =
    taskText + modePreamble(a) + (connectorSetup.instructions ? `${connectorSetup.instructions}\n\n` : '');

  const attempt = (resume: string | undefined): RunningHarness => {
    const runHarness =
      a.harness === 'bedrock' ? runBedrock : a.harness === 'codex' ? runCodex : runClaude;
    return runHarness(
      a,
      {
        binPath: harness.path,
        searchPath: deps.searchPath,
        workDir,
        cwd: taskCwd,
        mcpServerCmd: {
          command: deps.mcpEntry.command,
          args: deps.mcpEntry.args,
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            EX_BASE_URL: deps.baseUrl,
            EX_RUN_TOKEN: a.mcpToken,
            // Our per-run scratch (saved API responses, synced connector docs,
            // dev-server pid/log) — NOT the harness cwd, which for coding
            // tasks is the user's repo.
            EX_WORK_DIR: workDir,
            // Pre-approved harness tool classes (the user's "always allow"
            // prefs for this agent) — honored by the permission gateway.
            ...(a.autoAllow?.length ? { EX_AUTO_ALLOW: a.autoAllow.join(',') } : {}),
            ...(a.task && taskCwd
              ? {
                  EX_TASK_ID: a.task.id,
                  EX_TASK_DIR: taskCwd,
                  EX_TASK_PROJECT: a.task.projectKey,
                  // The repos with their local checkouts — the MCP server's
                  // request_mr walks these (push + MR per changed repo).
                  EX_TASK_REPOS: JSON.stringify(taskRepos),
                  EX_WORKSPACE_ROOT: deps.workspaceRoot || workspaceRoot(),
                }
              : {}),
            // Gated watchers (notify/draft/reply) are deterministic: the MCP
            // server hides ALL communication tools, so the agent only produces
            // final text and the SERVER routes it by mode. This env selects the
            // hidden set.
            EX_ACTION_MODE: a.actionMode ?? '',
            // Connector credentials for the connector_call tool — the MCP
            // server pins calls to each connector's base URL; the token never
            // reaches the harness shell.
            ...(connectorSetup.mcpConnectors ? { EX_CONNECTORS: connectorSetup.mcpConnectors } : {}),
          },
        },
        resumeSessionId: resume,
        // A resumed session already holds the earlier rounds: send the new
        // task + a nudge to re-read, not the whole bundle again.
        promptOverride: resume
          ? `${preamble}[continuing in the same thread]\n# Task\n${a.prompt}\n\nThe thread may have moved since your last turn — call get_thread and reply to the newest messages.`
          : preamble
            ? `${preamble}${a.prompt}\n\n${a.contextBundle}`
            : undefined,
        onSessionId: (sessionId) => {
          if (canResume) putSession(a, sessionId, workDir);
        },
        log: deps.log,
      },
      {
        turn: () => pump.push('turn'),
        usage: (inputTokens, outputTokens, cache) =>
          pump.push('usage', {
            inputTokens,
            outputTokens,
            // Cache split (when the harness reports one) — spend math stays
            // fresh-input-only, but without these fields a resume's 130k-token
            // turn is indistinguishable from 130k of real work.
            ...(cache ? { cacheReadTokens: cache.read, cacheCreationTokens: cache.creation } : {}),
          }),
        progress: (text) => pump.push('progress', { text: text.slice(0, 2000) }),
        tool: (name, detail, input) => {
          const clipped = clipToolInput(name, input);
          pump.push('tool', {
            name,
            ...(detail ? { detail: detail.slice(0, 300) } : {}),
            ...(clipped ? { input: clipped } : {}),
          });
        },
        // Results carry more than a snippet now — the drawer shows command
        // output and file contents inline, IDE-style.
        toolResult: (name, detail) =>
          pump.push('tool_result', { name, detail: detail.slice(0, 1500) }),
      },
    );
  };

  try {
    running = attempt(session?.sessionId);
    deps.onHarness?.(a.runID, (reason) => running?.kill(reason));
    pump.start();
    pump.push('state', { state: 'running' });
    // ⚙️ used to be the agent's first tool call — a model turn for a status
    // emoji. The runner sets it the moment the harness starts instead.
    void setRunStatus(deps.baseUrl, a.mcpToken, '⚙️').catch((err) =>
      deps.log('status set failed', { runID: a.runID, error: String(err) }),
    );
    // Ours-vs-harness transparency: report exactly what EX injects into the
    // prompt so turn-1 spend can be split between our content and the
    // harness's own overhead (its system prompt + tool machinery). Warm
    // resumes send the compact delta doc instead of the full bundle.
    {
      const rulesChars = systemRules(a.agentName, a.invokerName, a.persona, { connectors: runHasConnectors(a) }).length;
      const taskChars = session
        ? preamble.length + a.prompt.length + 160 // the resume delta doc
        : preamble.length + a.prompt.length + a.contextBundle.length + 2;
      pump.push('prompt', {
        rulesChars,
        taskChars,
        resumed: !!session,
        oursTokensEst: Math.round((rulesChars + taskChars) / 4),
      });
    }

    let outcome: RunOutcome = await running.outcome;

    // Failed resume → the cached session is dead (evicted, corrupted, wrong
    // cwd): drop it and go again cold. Doesn't consume the infra retry.
    if (!outcome.ok && session && infraFailure(outcome.reason)) {
      deps.log('resume failed; retrying with a fresh session', { runID: a.runID, reason: outcome.reason });
      dropSession(threadKey(a));
      session = null;
      running = attempt(undefined);
      deps.onHarness?.(a.runID, (reason) => running?.kill(reason));
      outcome = await running.outcome;
    }

    // One retry for infra-flavored failures (the CLI never ran / died
    // abnormally) — never for kills, deadlines, or model-level failures.
    if (!outcome.ok && infraFailure(outcome.reason)) {
      deps.log('infra failure; retrying once', { runID: a.runID, reason: outcome.reason });
      await sleepMs(3000);
      running = attempt(undefined);
      deps.onHarness?.(a.runID, (reason) => running?.kill(reason));
      outcome = await running.outcome;
    }

    await pump.stop();

    // Feed the session's weight estimate — the resume-vs-cold-start decision
    // in sessions.ts reads it (a fat stale session is pricier to replay than
    // a cold start's trimmed bundle).
    if (canResume) {
      addSessionCost(threadKey(a), outcome.usage.inputTokens + outcome.usage.outputTokens);
    }

    if (outcome.ok) {
      // Usage travels via the event pump ONLY (it retries on failure);
      // repeating it here double-counted every run's tokens.
      await deps.api.complete(deps.runnerID, a.runID, outcome.finalText, {
        inputTokens: 0,
        outputTokens: 0,
      });
    } else {
      await deps.api.fail(deps.runnerID, a.runID, outcome.reason ?? 'unknown');
    }
  } catch (err) {
    deps.log('run execution error', { runID: a.runID, error: String(err) });
    running?.kill('runner_error');
    await pump.stop().catch(() => {});
    await deps.api.fail(deps.runnerID, a.runID, `runner_error: ${String(err)}`).catch(() => {});
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    // Persistent thread dirs are swept by the session cache's eviction.
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
