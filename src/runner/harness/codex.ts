// Codex adapter: drives `codex exec --json` and maps its JSONL events onto
// runner events (plan-v2 §6). No Electron imports.
//
// Sandbox stance (plan-v2 §7, "Known gap", resolved by the shared-agent
// model): `--sandbox read-only` blocks writes and network but still permits
// local disk READS. Runs always execute on the INVOKER's own machine, so a
// codex pin only ever exposes the invoker's own disk to their own
// invocation — the plan's option (a), satisfied by construction.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';

import { describeToolUse } from '../describe-tool';
import type { Assignment, RunOutcome } from '../types';
import { flattenToolResult, killTree, runHasConnectors, systemRules } from './shared';
import type { HarnessEventSink, HarnessRunOptions, RunningHarness } from './shared';

const execFileP = promisify(execFile);

// tomlString renders a JS string as a TOML basic string. JSON string
// escaping is a strict subset of TOML basic-string escaping, so this is
// exact, not approximate.
function tomlString(s: string): string {
  return JSON.stringify(s);
}

// writeCodexHome builds the per-run CODEX_HOME (plan-v2 §7): a fresh
// config.toml carrying ONLY our MCP server + sandbox policy — never the
// user's real ~/.codex, whose config could re-enable tools or other MCP
// servers. The user's auth.json is COPIED in (CODEX_HOME is also where codex
// looks for credentials; an empty home would log the user out of the run).
// The run token rides the config file inside the 0700 temp dir — never argv.
function writeCodexHome(a: Assignment, opts: HarnessRunOptions): string {
  const home = path.join(opts.workDir, 'codex-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const userHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const authSrc = path.join(userHome, 'auth.json');
  try {
    fs.copyFileSync(authSrc, path.join(home, 'auth.json'));
  } catch {
    opts.log('codex: no auth.json found — run will rely on env auth if any', { authSrc });
  }

  const env = opts.mcpServerCmd.env;
  // Coding tasks need to edit files, install dependencies and run tests
  // inside the checkout: workspace-write (cwd = the checkout) with network.
  // Everything else stays read-only.
  const task = !!a.task;
  const lines = [
    '# Generated per-run by the Ex runner. Deleted with the run.',
    task ? 'sandbox_mode = "workspace-write"' : 'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    '',
    ...(task ? ['[sandbox_workspace_write]', 'network_access = true', ''] : []),
    '[history]',
    // save-all records the session rollout inside this per-thread CODEX_HOME
    // so follow-ups in the same thread can `exec resume` warm instead of
    // re-sending the whole bundle. Local to the thread workdir; swept with
    // the session. (Was "none" before codex threads were resumable.)
    'persistence = "save-all"',
    '',
    '[mcp_servers.ex]',
    `command = ${tomlString(opts.mcpServerCmd.command)}`,
    `args = [${opts.mcpServerCmd.args.map(tomlString).join(', ')}]`,
    // request_approval blocks while a human decides; codex's per-tool
    // timeout must outlast the orchestrator's approval deadline.
    'tool_timeout_sec = 600',
    // Codex gates every MCP tool call behind user approval, and with
    // approval_policy "never" it auto-CANCELS them ("user cancelled MCP tool
    // call") — no ex tool would ever run. Auto-approve our own server: this is
    // the same stance as claude's --allowedTools mcp__ex__*, and the tools
    // with real consequences (use_connector, request_approval) carry their own
    // human-consent flow server-side. The shell stays sandboxed read-only.
    'default_tools_approval_mode = "approve"',
    `env = { ${Object.entries(env)
      .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
      .join(', ')} }`,
    '',
  ];
  if (a.model) lines.splice(2, 0, `model = ${tomlString(a.model)}`);
  fs.writeFileSync(path.join(home, 'config.toml'), lines.join('\n'), { mode: 0o600 });
  return home;
}

// Flags drift across codex versions (plan-v2 §6) — probe `exec --help` once
// per binary and degrade with a legible reason instead of an opaque exit.
const helpCache = new Map<string, Promise<string>>();

async function execHelp(binPath: string, searchPath: string): Promise<string> {
  let cached = helpCache.get(binPath);
  if (!cached) {
    cached = execFileP(binPath, ['exec', '--help'], {
      timeout: 10_000,
      env: { ...process.env, PATH: searchPath },
    }).then(
      ({ stdout }) => stdout,
      () => '',
    );
    helpCache.set(binPath, cached);
  }
  return cached;
}

// Codex `exec --json` emits one JSON event per line. Two generations of
// shapes exist; both are mapped, unknown lines are ignored.
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    tool?: string;
    server?: string;
    command?: string;
    arguments?: unknown;
    status?: string;
    error?: { message?: string };
    result?: { content?: { type: string; text?: string }[] };
    exit_code?: number;
    aggregated_output?: string;
  };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
  // Legacy (pre-JSONL-v2) shape: {"id":"0","msg":{"type":"agent_message",...}}
  msg?: { type?: string; message?: string; last_agent_message?: string };
}

// runCodex spawns one bounded execution, mirroring runClaude's contract.
export function runCodex(a: Assignment, opts: HarnessRunOptions, sink: HarnessEventSink): RunningHarness {
  let killedReason = '';
  let childRef: { pid?: number } | null = null;

  const outcome = (async (): Promise<RunOutcome> => {
    const help = await execHelp(opts.binPath, opts.searchPath);
    if (!help.includes('--json')) {
      opts.log('codex: exec --help lacks --json; version too old', {});
      return {
        ok: false,
        finalText: '',
        reason: 'harness_incompatible: this codex version has no `exec --json`; update the Codex CLI',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const codexHome = writeCodexHome(a, opts);
    // Warm thread: resume the recorded session instead of cold-starting.
    // `exec resume` takes no --sandbox flag — the per-run config.toml's
    // sandbox_mode covers it. An id on a codex too old for resume fails as
    // spawn_failed, which run.ts treats as a dead session: drop + retry cold.
    if (opts.resumeSessionId && !help.includes('resume')) {
      return {
        ok: false,
        finalText: '',
        reason: 'spawn_failed: this codex version has no `exec resume`',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    const args = opts.resumeSessionId
      ? ['exec', 'resume', opts.resumeSessionId, '--json']
      : ['exec', '--json', '--sandbox', a.task ? 'workspace-write' : 'read-only'];
    if (help.includes('--skip-git-repo-check')) args.push('--skip-git-repo-check');
    // Prompt from stdin ("-" is codex's read-from-stdin sentinel): argv has
    // platform size limits and shows in `ps`; the bundle can be tens of KB.
    args.push('-');

    const child = spawn(opts.binPath, args, {
      cwd: opts.cwd ?? opts.workDir,
      detached: process.platform !== 'win32', // own process group → killable tree
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: opts.searchPath,
        CODEX_HOME: codexHome,
        CI: 'true',
      },
    });
    childRef = child;
    if (killedReason) killTree(child.pid, opts.log); // killed during the probe

    // Codex has no --append-system-prompt: the rules travel at the top of
    // the prompt document instead.
    // promptOverride (mode/connector preambles, warm-session deltas) replaces
    // the default task document, mirroring the claude adapter.
    const taskDoc = opts.promptOverride ?? `${a.prompt}\n\n${a.contextBundle}`;
    child.stdin.write(`${systemRules(a.agentName, a.invokerName, a.persona, { connectors: runHasConnectors(a) })}\n\n${taskDoc}`);
    child.stdin.end();

    let finalText = '';
    const usage = { inputTokens: 0, outputTokens: 0 };
    const stderrChunks: string[] = [];
    child.stderr.on('data', (d: Buffer) => {
      if (stderrChunks.length < 50) stderrChunks.push(d.toString());
    });

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => {
      let evt: CodexEvent;
      try {
        evt = JSON.parse(line) as CodexEvent;
      } catch {
        return; // non-JSON noise
      }
      switch (evt.type) {
        case 'thread.started':
          // The session handle for warm follow-ups in this thread — the
          // runner pins it per (agent, thread), mirroring claude's flow.
          if (evt.thread_id) opts.onSessionId?.(evt.thread_id);
          break;
        case 'turn.started':
          sink.turn();
          break;
        case 'item.completed': {
          const item = evt.item ?? {};
          if (item.type === 'agent_message' && item.text) {
            finalText = item.text; // the last agent message is the outcome
            sink.progress(item.text);
          } else if (item.type === 'reasoning' && item.text) {
            sink.progress(item.text);
          } else if (item.type === 'mcp_tool_call' && item.tool) {
            // Codex reports the call and its outcome on ONE completed item —
            // emit both timeline rows (call description + clipped result)
            // so codex runs read like claude runs in the drawer.
            const name = `mcp__${item.server ?? 'ex'}__${item.tool}`;
            const args =
              item.arguments && typeof item.arguments === 'object'
                ? (item.arguments as Record<string, unknown>)
                : {};
            sink.tool(name, describeToolUse(name, args), args);
            const flat = flattenToolResult(item.result?.content);
            if (item.status === 'failed') {
              sink.toolResult?.(name, `ERROR: ${item.error?.message ?? (flat || 'failed')}`);
            } else if (flat) {
              sink.toolResult?.(name, flat);
            }
          } else if (item.type === 'command_execution' && item.command) {
            sink.tool('shell', describeToolUse('Bash', { command: item.command }), { command: item.command });
            const out = flattenToolResult(item.aggregated_output);
            if (typeof item.exit_code === 'number' && item.exit_code !== 0) {
              sink.toolResult?.('shell', `ERROR: exit ${item.exit_code} ${out}`.trim());
            } else if (out) {
              sink.toolResult?.('shell', out);
            }
          }
          break;
        }
        case 'turn.completed':
          if (evt.usage) {
            // Codex's input_tokens counts the FULL context every turn,
            // cached reads included — a multi-turn run re-bills the same
            // ~50k context each turn and trips the orchestrator's
            // token_budget while barely using the model. Count fresh input
            // only (cache reads are ~free), matching claude's accounting.
            const inTok = Math.max(
              0,
              (evt.usage.input_tokens ?? 0) - (evt.usage.cached_input_tokens ?? 0),
            );
            const outTok = evt.usage.output_tokens ?? 0;
            usage.inputTokens += inTok;
            usage.outputTokens += outTok;
            sink.usage(inTok, outTok);
          }
          break;
        case 'turn.failed':
        case 'error': {
          // Surface harness-level errors in the run timeline, not just the
          // local log — "user cancelled MCP tool call" was invisible here.
          const msg = evt.error?.message ?? evt.message ?? 'unknown error';
          opts.log('codex error event', { message: msg });
          sink.toolResult?.('codex', `ERROR: ${msg}`);
          break;
        }
        default: {
          // Legacy event stream (msg envelope).
          const msg = evt.msg;
          if (!msg?.type) break;
          if (msg.type === 'agent_message' && msg.message) {
            finalText = msg.message;
            sink.progress(msg.message);
          } else if (msg.type === 'task_started') {
            sink.turn();
          } else if (msg.type === 'task_complete' && msg.last_agent_message) {
            finalText = msg.last_agent_message;
          }
          break;
        }
      }
    });

    return new Promise<RunOutcome>((resolve) => {
      child.on('error', (err) => {
        resolve({ ok: false, finalText: '', reason: `spawn_failed: ${err.message}`, usage });
      });
      child.on('close', (code) => {
        if (killedReason) {
          resolve({ ok: false, finalText: '', reason: killedReason, usage });
          return;
        }
        if (code === 0) {
          resolve({ ok: true, finalText, usage });
          return;
        }
        const stderr = stderrChunks.join('').slice(0, 500);
        opts.log('codex exited non-zero', { code, stderr });
        resolve({ ok: false, finalText: '', reason: `harness_exit_${String(code)}`, usage });
      });
    });
  })();

  const kill = (reason: string): void => {
    if (killedReason) return;
    killedReason = reason;
    if (childRef?.pid) killTree(childRef.pid, opts.log);
  };

  return { outcome, kill };
}
