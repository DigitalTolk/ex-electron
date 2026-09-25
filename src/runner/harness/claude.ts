// Claude Code adapter: drives `claude -p --output-format stream-json` and
// maps its JSONL events onto runner events (plan-v2 §6). No Electron imports.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { describeToolUse } from '../describe-tool';
import { turnsFor } from '../types';
import type { Assignment, RunOutcome } from '../types';
import { flattenToolResult, killTree, runHasConnectors, systemRules } from './shared';
import type { HarnessEventSink, HarnessRunOptions, RunningHarness } from './shared';

export type { HarnessEventSink, HarnessRunOptions, RunningHarness } from './shared';

// The Ex tools are AUTO-ALLOWED (no permission prompt — they're already
// bounded by the invoker's access server-side). Everything else — Claude's
// native Bash/Write/WebSearch/… — is now AVAILABLE but routed through the
// permission gateway: --permission-prompt-tool calls mcp__ex__approval_prompt,
// which becomes an approval card the INVOKER clicks. Open by default, gated
// by a human — not hard-blocked.
const ALLOWED_TOOLS = [
  'mcp__ex__post_message',
  'mcp__ex__get_thread',
  'mcp__ex__get_context',
  'mcp__ex__write_shared_context',
  'mcp__ex__request_approval',
  'mcp__ex__publish_artifact',
  'mcp__ex__list_skills',
  'mcp__ex__invoke_skill',
  'mcp__ex__list_channels',
  'mcp__ex__create_channel',
  'mcp__ex__join_channel',
  'mcp__ex__read_channel',
  'mcp__ex__post_to_channel',
  'mcp__ex__search_messages',
  'mcp__ex__add_reaction',
  'mcp__ex__list_users',
  'mcp__ex__send_dm',
  'mcp__ex__update_memory',
  'mcp__ex__claim_task',
  'mcp__ex__set_state',
  'mcp__ex__set_reminder',
  'mcp__ex__list_reminders',
  'mcp__ex__cancel_reminder',
  'mcp__ex__pin_message',
  'mcp__ex__notify_owner',
  'mcp__ex__propose_reply',
  'mcp__ex__link_message',
  'mcp__ex__fetch_spill',
  'mcp__ex__connector_call',
  'mcp__ex__use_connector',
  'mcp__ex__connector_lookup',
  // Coding tasks (plan-coding-agent.md).
  'mcp__ex__create_coding_task',
  'mcp__ex__publish_test_link',
  'mcp__ex__request_mr',
  'mcp__ex__task_state',
  'mcp__ex__register_project_commands',
].join(',');

const PERMISSION_PROMPT_TOOL = 'mcp__ex__approval_prompt';

// request_approval legitimately blocks for minutes while a human decides —
// the harness's own MCP tool timeout must sit ABOVE the orchestrator's
// approval deadline so the deadline resolves inside the call (plan-v2 §7).
const MCP_TOOL_TIMEOUT_MS = 10 * 60_000;

// systemPrompt layers the platform rules over the agent's persona
// (plan.md §11 kept short). Connector instructions ride the TOP of the task
// prompt instead (run.ts preamble) — priority position, not system fine print.
function systemPrompt(a: Assignment): string {
  return systemRules(a.agentName, a.invokerName, a.persona, { connectors: runHasConnectors(a) });
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: {
    id?: string;
    content?: {
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      is_error?: boolean;
      content?: string | { type: string; text?: string }[];
    }[];
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

// freshInput is the spend metric both adapters agree on: tokens the model
// processed for the FIRST time this run. Anthropic splits input three ways —
// input_tokens (uncached) + cache_creation (first write, real work) +
// cache_read (cheap replay). Counting only input_tokens hides ~90% of a
// multi-turn run's real input; counting cache reads too would re-bill the
// whole context every turn (the codex token_budget bug, mirrored). So:
// uncached + cache writes, reads excluded. Codex equivalent:
// input_tokens - cached_input_tokens.
function freshInput(u: { input_tokens?: number; cache_creation_input_tokens?: number }): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}


// runClaude spawns one bounded execution. The child gets its own process
// group so cancellation kills the whole tree — CLIs spawn children, and a
// stray MCP server or helper outliving the run is a leak (plan-v2 §6).
export function runClaude(a: Assignment, opts: HarnessRunOptions, sink: HarnessEventSink): RunningHarness {
  // Guarantee the working directory rather than assuming it: a retry after a
  // failed resume drops the session (which sweeps this very dir) and then
  // re-attempts in the same path, so by the time we get here it may be gone.
  // Writing mcp.json into a missing dir throws ENOENT and kills the run before
  // the model ever starts — 0 turns, no answer, just a failed reaction.
  // Cheap and idempotent; codex's writeCodexHome already does the equivalent.
  fs.mkdirSync(opts.workDir, { recursive: true });

  const mcpConfigPath = path.join(opts.workDir, 'mcp.json');
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        ex: {
          command: opts.mcpServerCmd.command,
          args: opts.mcpServerCmd.args,
          // Run token rides env, never argv (plan-v2 §7).
          env: opts.mcpServerCmd.env,
        },
      },
    }),
    'utf8',
  );

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    ALLOWED_TOOLS,
    '--permission-prompt-tool',
    PERMISSION_PROMPT_TOOL,
    '--append-system-prompt',
    systemPrompt(a),
  ];
  if (a.model) args.push('--model', a.model);
  if (opts.resumeSessionId) {
    // Warm session: continue the per-thread conversation instead of cold
    // starting — the earlier rounds' context is already in the session.
    args.push('--resume', opts.resumeSessionId);
  }
  {
    // Local fast-fail; the orchestrator is authoritative either way. MODE-
    // AWARE: a direct task gets the task budget — passing the conversation
    // cap (16) here cut deep connector workflows off mid-task (the CLI
    // exited 1 with error_max_turns right after delivering, and the runner
    // then re-ran the whole completed task as an "infra" retry).
    const cap = turnsFor(a.limits, a.mode);
    if (cap > 0) args.push('--max-turns', String(cap));
  }

  const child = spawn(opts.binPath, args, {
    cwd: opts.cwd ?? opts.workDir,
    detached: process.platform !== 'win32', // own process group → killable tree
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: opts.searchPath,
      // Keep the harness out of interactive candy.
      CI: 'true',
      // request_approval blocks while a human decides; the CLI's MCP tool
      // timeout must outlast the orchestrator's approval deadline.
      MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      MCP_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
      // Progressive MCP: defer the ~37 Ex tool schemas (~6k tokens) behind
      // ToolSearch — the model gets a petite name+one-line catalog and pulls a
      // tool's full schema only when it decides to use it. Measured ~24% off
      // the per-request prompt (~9k tokens: the tool block collapses to the
      // catalog). Claude Code does this automatically above a tool-size
      // threshold, but ONLY on a first-party Anthropic host — the optimistic
      // path is auto-disabled when ANTHROPIC_BASE_URL points at a gateway
      // (Bedrock proxy, etc.). Setting this forces it on there too; it's a
      // no-op when the default host already defers. The cached system-prompt +
      // catalog prefix stays warm because loaded schemas are APPENDED as
      // tool-search results, not prepended into the tools block.
      ENABLE_TOOL_SEARCH: 'true',
    },
  });

  // The prompt goes over stdin (argv has platform size limits and shows in
  // `ps`; the bundle can be tens of KB). A resumed session gets the compact
  // override instead of the whole bundle.
  child.stdin.write(opts.promptOverride ?? `${a.prompt}\n\n${a.contextBundle}`);
  child.stdin.end();

  let finalText = '';
  let usage = { inputTokens: 0, outputTokens: 0 };
  // The final result event's subtype ('success' | 'error_max_turns' | …).
  // null until a result event arrives.
  let resultSubtype: string | null = null;
  // tool_use id → tool name, so tool_result events (which only carry the id)
  // can be attributed in the timeline.
  const toolNames = new Map<string, string>();
  // Tokens already streamed via per-turn assistant usage — the final result
  // event carries TOTALS, so only the remainder is reported at the end
  // (otherwise the drawer would double-count).
  let streamedIn = 0;
  let streamedOut = 0;
  let killedReason = '';
  // Assistant message ids already counted for turn/usage — see the
  // 'assistant' case: the same message streams once per content block.
  const seenAssistantMsgs = new Set<string>();

  const stderrChunks: string[] = [];
  child.stderr.on('data', (d: Buffer) => {
    if (stderrChunks.length < 50) stderrChunks.push(d.toString());
  });

  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  rl.on('line', (line) => {
    let evt: ClaudeStreamEvent;
    try {
      evt = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return; // non-JSON noise
    }
    if (evt.session_id && evt.type === 'system') {
      opts.onSessionId?.(evt.session_id);
    }
    switch (evt.type) {
      case 'assistant': {
        // stream-json re-sends the SAME assistant message once per content
        // block (text, then each tool_use), each copy carrying the full
        // message.usage — counting every copy doubled turns and tokens.
        // Blocks differ across copies, so tools/progress still process every
        // event; turn + usage count once per message id.
        const mid = evt.message?.id ?? '';
        const firstCopy = !mid || !seenAssistantMsgs.has(mid);
        if (mid) seenAssistantMsgs.add(mid);
        if (firstCopy) sink.turn();
        for (const block of evt.message?.content ?? []) {
          if (block.type === 'text' && block.text) sink.progress(block.text);
          if (block.type === 'tool_use' && block.name) {
            // The timeline narrates WHAT the call does, not just the tool
            // name — "cliffhub API: GET api/leave/requests?…" beats "Tool".
            let detail: string | undefined;
            try {
              detail = describeToolUse(block.name, block.input ?? {});
            } catch {
              detail = undefined;
            }
            if (block.id) toolNames.set(block.id, block.name);
            sink.tool(block.name, detail, block.input ?? undefined);
          }
        }
        // Per-turn usage streams live so the drawer's spend ticks during the
        // run instead of jumping from 0 at the very end.
        const u = evt.message?.usage;
        if (firstCopy && u && (freshInput(u) > 0 || (u.output_tokens ?? 0) > 0)) {
          sink.usage(freshInput(u), u.output_tokens ?? 0, {
            read: u.cache_read_input_tokens ?? 0,
            creation: u.cache_creation_input_tokens ?? 0,
          });
          streamedIn += freshInput(u);
          streamedOut += u.output_tokens ?? 0;
        }
        break;
      }
      case 'user': {
        // Tool RESULTS ride user-role messages in stream-json. Report each as
        // a timeline event: what came back, clipped + sized.
        for (const block of evt.message?.content ?? []) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const name = toolNames.get(block.tool_use_id) ?? 'tool';
          const flat = flattenToolResult(block.content);
          if (!flat) continue;
          sink.toolResult?.(name, block.is_error ? `ERROR: ${flat}` : flat);
        }
        break;
      }
      case 'result': {
        finalText = evt.result ?? '';
        resultSubtype = evt.subtype ?? 'success';
        usage = {
          inputTokens: evt.usage ? freshInput(evt.usage) : 0,
          outputTokens: evt.usage?.output_tokens ?? 0,
        };
        if (evt.usage) {
          // Report only what per-turn streaming hasn't already counted.
          const inRem = Math.max(0, usage.inputTokens - streamedIn);
          const outRem = Math.max(0, usage.outputTokens - streamedOut);
          if (inRem > 0 || outRem > 0) sink.usage(inRem, outRem);
        }
        break;
      }
      default:
        break; // system/init etc.
    }
  });

  const outcome = new Promise<RunOutcome>((resolve) => {
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
      opts.log('claude exited non-zero', { code, subtype: resultSubtype, stderr });
      // A completed SUCCESS result outranks the exit code: the work was
      // delivered; whatever poisoned the exit (MCP shutdown, cleanup) must
      // not fail the run — and above all must not trigger an infra retry
      // that re-runs an already-completed task.
      if (resultSubtype === 'success' && finalText) {
        resolve({ ok: true, finalText, usage });
        return;
      }
      // A model-level ending (max turns, execution error) is NOT infra —
      // report its real name so the retry classifier leaves it alone.
      const reason = resultSubtype && resultSubtype !== 'success'
        ? resultSubtype
        : `harness_exit_${String(code)}`;
      resolve({ ok: false, finalText: '', reason, usage });
    });
  });

  const kill = (reason: string): void => {
    if (killedReason) return;
    killedReason = reason;
    killTree(child.pid, opts.log);
  };

  return { outcome, kill };
}
