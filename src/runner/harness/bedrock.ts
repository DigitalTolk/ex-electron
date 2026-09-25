// Bedrock API harness: instead of spawning a local CLI, run the agent loop
// against a hosted model via AWS Bedrock's Converse API. It drives the SAME
// MCP server the CLI harnesses use — as an MCP stdio client — so every ex
// tool (post_message, get_thread, approvals, workspace…) works identically
// and the whole safety surface (approval gates, injection framing, spend
// caps) is unchanged. No local shell/files: an API agent only has ex tools.
//
// Credentials/region come from the machine's AWS environment (env / ~/.aws /
// instance profile) via the SDK's default provider chain — this is the
// runner-side execution mode. Server-side (SSO-federated) execution is a
// separate backend path.
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';

import type { Assignment, RunOutcome } from '../types';
import { killTree, runHasConnectors, systemRules } from './shared';
import type { HarnessEventSink, HarnessRunOptions, RunningHarness } from './shared';
import { mcpResultToText, toConverseToolConfig, type McpTool } from './bedrock-tools';
import { deriveMessages, type SessionEvent } from './bedrock-log';

// Hard ceiling on Converse round-trips regardless of the run's maxTurns — a
// backstop against a model that never stops calling tools. The orchestrator
// is still authoritative on turns/tokens via the event pump.
const MAX_ITERS_CEIL = 40;

function awsRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

// The MCP handshake (initialize + tools/list) must complete quickly; if the
// server never answers, fail fast rather than hang until the run deadline.
// tools/call has NO such timeout on purpose — request_approval / ask_user
// legitimately block for minutes waiting on the invoker — so those are bounded
// only by child death and the orchestrator's wall-clock deadline.
const MCP_HANDSHAKE_TIMEOUT_MS = 30_000;

// mcpClient is a minimal JSON-RPC-over-stdio MCP client — enough to
// initialize, list tools, and call them against the spawned ex MCP server.
class mcpClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rl: readline.Interface;
  private dead: Error | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly log: HarnessRunOptions['log'],
  ) {
    this.rl = readline.createInterface({ input: child.stdout!, terminal: false });
    this.rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        const msg = JSON.parse(t) as { id?: number; result?: unknown };
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            p.resolve(msg.result);
          }
        }
      } catch {
        // non-JSON stderr/noise on stdout — ignore
      }
    });
    // If the MCP server dies, reject every in-flight call so awaiting harness
    // code fails immediately instead of blocking until the run deadline.
    const die = (why: string) => this.fail(new Error(why));
    child.once('exit', (code) => die(`mcp server exited (code ${code ?? 'null'})`));
    child.once('error', (err) => die(`mcp server error: ${String(err)}`));
    // Writing to a dead child emits 'error' (EPIPE) on the stream, not a throw.
    child.stdin?.on('error', (err) => die(`mcp stdin error: ${String(err)}`));
  }

  // fail rejects and clears all pending calls; subsequent rpc() calls reject
  // synchronously via `this.dead`.
  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private rpc(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    this.seq += 1;
    const id = this.seq;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      const settle = { resolve, reject };
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          settle.resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          settle.reject(e);
        },
      });
      try {
        this.child.stdin!.write(line + '\n');
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error(`mcp write failed: ${String(err)}`));
      }
    });
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} }, MCP_HANDSHAKE_TIMEOUT_MS);
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.rpc('tools/list', undefined, MCP_HANDSHAKE_TIMEOUT_MS)) as { tools?: McpTool[] };
    return res?.tools ?? [];
  }

  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    return this.rpc('tools/call', { name, arguments: args }).then(mcpResultToText);
  }

  close(): void {
    try {
      this.rl.close();
      this.child.stdin?.end();
    } catch (err) {
      this.log('mcp client close failed', { error: String(err) });
    }
  }
}

// runBedrock matches the CLI harnesses' contract (Assignment, opts, sink) →
// RunningHarness, so run.ts dispatches it identically.
export function runBedrock(a: Assignment, opts: HarnessRunOptions, sink: HarnessEventSink): RunningHarness {
  const abort = new AbortController();
  let child: ChildProcess | null = null;
  let killed: string | null = null;

  const outcome: Promise<RunOutcome> = (async () => {
    if (!a.model) {
      return { ok: false, finalText: '', reason: 'model_missing:bedrock', usage: { inputTokens: 0, outputTokens: 0 } };
    }
    // Spawn the ex MCP server (same entry the CLI path uses) and speak MCP to
    // it. The run token rides env, never argv.
    child = spawn(opts.mcpServerCmd.command, opts.mcpServerCmd.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...opts.mcpServerCmd.env },
    });
    const mcp = new mcpClient(child, opts.log);

    const client = new BedrockRuntimeClient({ region: awsRegion() });
    let inTok = 0;
    let outTok = 0;

    try {
      await mcp.initialize();
      const tools = await mcp.listTools();
      const toolConfig = toConverseToolConfig(tools);

      const system = [{ text: systemRules(a.agentName, a.invokerName, a.persona, { connectors: runHasConnectors(a) }) }];
      // Mirror the CLI harnesses: the task instruction (a.prompt) leads, then
      // the thread context. A resume/mode preamble arrives via promptOverride.
      const userText = opts.promptOverride ?? `${a.prompt}\n\n${a.contextBundle}`;
      // APPEND-ONLY session log — the single source of the model's view.
      // Every Converse request derives its messages from this log
      // (deriveMessages), so anything model-visible is logged by construction
      // and the run is replayable from the log alone. Never build or mutate
      // a messages array directly.
      const sessionLog: SessionEvent[] = [{ kind: 'user', text: userText }];

      const wantIters = a.limits.maxTurns && a.limits.maxTurns > 0 ? a.limits.maxTurns : MAX_ITERS_CEIL;
      const maxIters = Math.min(wantIters, MAX_ITERS_CEIL);
      let finalText = '';

      for (let iter = 0; iter < maxIters; iter++) {
        if (killed) return { ok: false, finalText, reason: killed, usage: { inputTokens: inTok, outputTokens: outTok } };
        sink.turn();

        const resp = await client.send(
          new ConverseCommand({
            modelId: a.model,
            system,
            messages: deriveMessages(sessionLog),
            toolConfig: toolConfig.tools.length ? (toolConfig as unknown as { tools: Tool[] }) : undefined,
            inferenceConfig: { maxTokens: 4096 },
          }),
          { abortSignal: abort.signal },
        );

        const u = resp.usage;
        if (u) {
          const di = u.inputTokens ?? 0;
          const dOut = u.outputTokens ?? 0;
          inTok += di;
          outTok += dOut;
          sink.usage(di, dOut); // report the DELTA; the pump aggregates
        }

        const assistant = resp.output?.message;
        if (assistant) sessionLog.push({ kind: 'assistant', message: assistant });
        const blocks: ContentBlock[] = assistant?.content ?? [];

        const text = blocks
          .map((b) => ('text' in b ? b.text : undefined))
          .filter((t): t is string => typeof t === 'string')
          .join('\n')
          .trim();
        if (text) {
          finalText = text;
          sink.progress(text);
        }

        if (resp.stopReason !== 'tool_use') {
          return { ok: true, finalText, reason: undefined, usage: { inputTokens: inTok, outputTokens: outTok } };
        }

        // Execute every requested tool; each result is one log event —
        // deriveMessages folds consecutive results into the single user turn
        // the Converse API requires.
        let toolCalls = 0;
        for (const b of blocks) {
          if (!('toolUse' in b) || !b.toolUse) continue;
          const { toolUseId, name, input } = b.toolUse;
          sink.tool(name ?? 'unknown');
          const out = await mcp.callTool(name ?? '', (input as Record<string, unknown>) ?? {});
          toolCalls += 1;
          sessionLog.push({ kind: 'tool_result', toolUseId: toolUseId!, text: out.text, isError: out.isError });
        }
        // stopReason was tool_use but the turn carried no toolUse blocks — there
        // is nothing to feed back, and Bedrock rejects an empty user turn. Treat
        // it as done with whatever text we have rather than sending [] and
        // provoking a hard model_error.
        if (toolCalls === 0) {
          return { ok: true, finalText, reason: undefined, usage: { inputTokens: inTok, outputTokens: outTok } };
        }
      }

      // Ran out of iterations — treat as a soft completion with whatever text
      // we have; the orchestrator's turn cap is the authoritative bound.
      return { ok: true, finalText, reason: undefined, usage: { inputTokens: inTok, outputTokens: outTok } };
    } catch (err) {
      if (killed) return { ok: false, finalText: '', reason: killed, usage: { inputTokens: inTok, outputTokens: outTok } };
      const msg = String(err);
      // Auth/permission/throttle from Bedrock are model-level, not infra —
      // reason prefix keeps run.ts from retrying them as spawn failures.
      opts.log('bedrock converse failed', { runID: a.runID, error: msg });
      return { ok: false, finalText: '', reason: `model_error:${msg.slice(0, 200)}`, usage: { inputTokens: inTok, outputTokens: outTok } };
    } finally {
      mcp.close();
      killTree(child?.pid, opts.log);
    }
  })();

  return {
    outcome,
    kill(reason: string) {
      killed = `abort:${reason}`;
      abort.abort();
      killTree(child?.pid, opts.log);
    },
  };
}
