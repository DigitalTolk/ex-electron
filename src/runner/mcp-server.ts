// Local MCP stdio server — the agent's hands (plan-v2 §7). Spawned BY the
// harness CLI (which is the MCP client) from the per-run config the runner
// writes; runs under the Electron binary with ELECTRON_RUN_AS_NODE=1 so we
// never depend on a system Node install.
//
// Every tool call becomes an authenticated REST call to the ex backend using
// the run-scoped token from the environment (EX_RUN_TOKEN — env, never argv:
// argv is world-readable in `ps`). The token carries the invoker's
// permissions and dies with the run, so this process can never do anything
// the invoking human couldn't.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio, MCP 2024-11-05.
// Hand-rolled on purpose — three methods and a tiny tool set don't justify
// an SDK dependency inside the shell.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { flattenBackendError } from './backend-error';
import { lookup, readOptional, servicesFromUsage } from './connector-docs';
import { credentialHeader, fetchRunConnectors, syncConnectors } from './connectors';
import { describeToolUse } from './describe-tool';
import { SpillStore, SPILL_FETCH_MAX } from './spill';
import { taskPolicyAllows } from './task-policy';
import {
  branchHasChanges,
  createMergeRequest,
  gitHostFromBaseURL,
  pushBranch,
  startDevServer,
  stopDevServer,
  updateProjectCommands,
  workspaceRoot,
} from './workspace';

const BASE_URL = process.env.EX_BASE_URL ?? '';
const RUN_TOKEN = process.env.EX_RUN_TOKEN ?? '';
// Our per-run scratch dir (saved API responses, synced connector docs, the
// dev-server pid/log). Distinct from process.cwd(): for coding tasks the
// harness — and therefore this server — runs INSIDE the user's repo, and
// nothing of ours may land there.
const WORK_DIR = process.env.EX_WORK_DIR || process.cwd();
// Coding task (plan-coding-agent.md): set only on task-mode runs. TASK_DIR is
// the project checkout the task permission profile is scoped to.
const TASK_ID = process.env.EX_TASK_ID ?? '';
const TASK_DIR = process.env.EX_TASK_DIR ?? '';
const TASK_PROJECT = process.env.EX_TASK_PROJECT ?? '';
// The task's repos with their local checkouts (from the runner's workspace
// preparation): request_mr pushes + opens an MR per CHANGED repo.
interface TaskRepoEnv {
  path: string;
  role: string;
  dir: string;
  branch: string;
  base: string;
}
const TASK_REPOS: TaskRepoEnv[] = (() => {
  try {
    const rows = JSON.parse(process.env.EX_TASK_REPOS ?? '[]') as TaskRepoEnv[];
    return Array.isArray(rows) ? rows.filter((r) => r && r.path && r.dir && r.branch) : [];
  } catch {
    return [];
  }
})();
// Tools that only make sense inside a task run — hidden elsewhere so a plain
// chat run never sees "request_mr".
const TASK_ONLY = new Set(['publish_test_plan', 'request_mr', 'task_state', 'register_project_commands']);
// Harness tool classes the invoker pre-approved for this agent ("always allow
// reads") — the permission gateway skips the card for them.
const AUTO_ALLOW = new Set(
  (process.env.EX_AUTO_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// toolClass maps a harness tool onto the user-facing permission classes.
export function toolClass(toolName: string): 'read' | 'edit' | 'shell' | 'web' | '' {
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'NotebookRead':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
      return 'shell';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    default:
      return '';
  }
}
// Gated watcher modes (notify/draft/reply) are DETERMINISTIC: the agent never
// routes its own output. It reads context, then produces a final answer as
// text; the SERVER delivers that text according to the mode (notify/draft → DM
// the creator, reply → editable approval → post on approve). So we hide every
// tool that communicates or acts on the agent's behalf — the agent can't (and
// needn't) choose how to deliver, which removes the "did the model remember to
// call notify_owner?" failure that made watchers unreliable. Only autonomous
// keeps the full posting surface.
const ACTION_MODE = process.env.EX_ACTION_MODE ?? '';
const GATED = ACTION_MODE === 'notify' || ACTION_MODE === 'draft' || ACTION_MODE === 'reply';

// Connectors attached to this run (the invoking message's /picks), passed as
// JSON via env so the credential never touches the harness shell or disk. The
// connector_call tool is the ONLY path to these APIs: the URL is pinned to
// the connector's base URL, so the agent cannot aim the token anywhere else.
interface ConnectorCred {
  slug: string;
  title: string;
  baseURL: string;
  token: string;
  authHeader?: string; // header template; empty = Authorization: Bearer
}
const CONNECTORS: Map<string, ConnectorCred> = (() => {
  const map = new Map<string, ConnectorCred>();
  try {
    const rows = JSON.parse(process.env.EX_CONNECTORS ?? '[]') as ConnectorCred[];
    for (const r of rows) {
      if (r && r.slug && r.baseURL && r.token) map.set(r.slug, r);
    }
  } catch {
    // malformed env → no connectors
  }
  return map;
})();
// Every tool that emits a message/action outward. In gated modes the mode owns
// delivery, so none of these are offered — the agent's final text is the
// deliverable, full stop.
const GATED_HIDDEN = new Set([
  'post_message',
  'post_to_channel',
  'send_dm',
  'add_reaction',
  'notify_owner',
  'propose_reply',
]);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// visibleTools is the advertised tool set for this run. Gated watchers get the
// read/side-effect tools but none of the communication tools — delivery is the
// server's job, decided deterministically by the action mode.
function visibleTools(): ToolDef[] {
  // connector_call/use_connector stay advertised even with nothing attached:
  // use_connector can attach mid-run (harnesses cache the tool list, so
  // hiding-then-revealing wouldn't propagate). Calling with nothing attached
  // errors legibly instead.
  let tools = TOOLS;
  if (!TASK_ID) tools = tools.filter((t) => !TASK_ONLY.has(t.name));
  if (GATED) tools = tools.filter((t) => !GATED_HIDDEN.has(t.name));
  return tools;
}

// Tool contracts (descriptions say WHEN, not just what — the harness routes
// on them). Results are lean text carrying the same [m:<id>] labels the
// context bundle uses.
const TOOLS: ToolDef[] = [
  {
    name: 'post_message',
    description:
      'Post your reply into the chat thread you were invoked from. Use this to deliver your ' +
      'answer or a substantial partial result. Posts are capped per task — prefer one useful ' +
      'message over many partial ones. Writing another agent\'s name as @name (e.g. "@qib") ' +
      'hands them the turn: they will be invoked and see your message. Only mention an agent ' +
      'when you want them to respond.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Message text (markdown).' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_thread',
    description:
      'Re-read the conversation thread. Use when you need messages beyond the context you were ' +
      'given, or to check whether the thread moved while you were working. Each line is ' +
      '[m:<messageID>] <author> (<human|agent>) <time>: <text>.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_context',
    description:
      'Re-read your FULL context document, assembled fresh: the task, the shared context items ' +
      'for this channel, what other agents concluded in this thread, and the thread itself. Use ' +
      'when you have been working long enough that your starting context may be stale. For just ' +
      'the newest messages, get_thread is cheaper.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'write_shared_context',
    description:
      'Store one durable fact, decision, or constraint in this channel\'s shared context, where ' +
      'EVERY future agent run in this channel will see it. Use sparingly — only for conclusions ' +
      'worth remembering beyond this thread, not for progress notes (post_message) or your ' +
      'answer. Items are small (≤2KB) and the channel holds at most 50.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The fact to remember (markdown, ≤2KB).' },
        pinned: {
          type: 'boolean',
          description: 'Pin so it survives context trimming. Reserve for hard constraints.',
        },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_approval',
    description:
      'Ask the human who invoked you to approve a consequential action BEFORE taking it — e.g. ' +
      'posting to a wide audience, or anything they might reasonably want to veto. BLOCKS until ' +
      'they approve, deny, or the request times out (a timeout is a denial). Use sparingly; ' +
      'routine replies need no approval.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One or two sentences: exactly what you want to do and why.',
        },
        risk: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Your assessment of the blast radius.',
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_artifact',
    description:
      'Publish a document too long or too durable for a chat message — a full draft, report, or ' +
      'diff. It is stored on the run and viewable in its activity drawer. Post a SHORT summary ' +
      'with post_message and mention the artifact title; do not paste the whole document into ' +
      'chat. Max 64KB, a few per run.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Content kind, e.g. "markdown", "diff", "text".' },
        title: { type: 'string', description: 'Short human-readable title.' },
        content: { type: 'string', description: 'The full document.' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_skills',
    description:
      'List the workspace skill packs — named instruction sets your team curated for recurring ' +
      'tasks (release notes format, review checklist, …). Check here when the task sounds like ' +
      'something the team does routinely; follow up with invoke_skill to pull in the one that fits.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'invoke_skill',
    description:
      'Fetch one skill\'s full instructions by id (from list_skills) and follow them for the ' +
      'current task. The invocation is recorded on the run timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        skillID: { type: 'string', description: 'The skill id from list_skills.' },
      },
      required: ['skillID'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_channels',
    description:
      'List the channels your invoker is a member of — the places you can read and post with ' +
      'their access. Lines are [ch:<channelID>] ~name (public|private).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_channel',
    description:
      'Create a new channel in the workspace, as your invoker (their access level applies — ' +
      'guests cannot create channels). Consider request_approval first unless they explicitly ' +
      'asked you to create it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name.' },
        description: { type: 'string' },
        private: { type: 'boolean', description: 'Private channel (default public).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'join_channel',
    description: 'Join your invoker to a public channel by [ch:<id>] so you can read/post there.',
    inputSchema: {
      type: 'object',
      properties: { channelID: { type: 'string' } },
      required: ['channelID'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_channel',
    description:
      'Read a channel (one your invoker is in) by [ch:<id>]. Without thread: recent TOP-LEVEL ' +
      'messages only — replies are hidden, [thread: N replies] marks where they live. With ' +
      'thread (any message id from that thread; a permalink\'s #msg-<id> works too): that ' +
      'thread\'s actual messages. When a task points at a message or thread, read it here ' +
      'directly — do not reconstruct it from search. Same [m:<id>] line format as get_thread.',
    inputSchema: {
      type: 'object',
      properties: {
        channelID: { type: 'string' },
        thread: {
          type: 'string',
          description: 'Any message id inside the thread to read; omit for the channel top level.',
        },
        limit: { type: 'number', description: 'Max messages (≤50).' },
      },
      required: ['channelID'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_pins',
    description:
      'List a channel\'s pinned messages — the durable decisions, links and reference posts ' +
      'members chose to keep visible. Check pins before asking a human for standing facts ' +
      'about a channel.',
    inputSchema: {
      type: 'object',
      properties: { channelID: { type: 'string' } },
      required: ['channelID'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_dm',
    description:
      'Read your INVOKER\'s own direct-message history with one user (they already see it in ' +
      'the app). Use it when the task references something said in a DM; accepts the same ' +
      'thread narrowing as read_channel.',
    inputSchema: {
      type: 'object',
      properties: {
        userID: { type: 'string', description: 'The other participant\'s user id.' },
        thread: { type: 'string', description: 'Optional message id inside a DM thread.' },
        limit: { type: 'number', description: 'Max messages (≤50).' },
      },
      required: ['userID'],
      additionalProperties: false,
    },
  },
  {
    name: 'post_to_channel',
    description:
      'Post a message into a channel by [ch:<id>] your invoker is a member of (any channel, ' +
      'including your current one). To answer a message that was asked in a THREAD, pass ' +
      'thread_root = that message\'s [m:<id>] so your reply lands in the thread, not at the top ' +
      'level. For replying in the exact thread you were invoked from, post_message is simpler. ' +
      'Shares your per-task post cap.',
    inputSchema: {
      type: 'object',
      properties: {
        channelID: { type: 'string' },
        body: { type: 'string', description: 'Message text (markdown).' },
        thread_root: {
          type: 'string',
          description: 'Message ID to reply under (the thread root). Omit to post at the top level.',
        },
      },
      required: ['channelID', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description:
      'Full-text search across all history your invoker can see — for DISCOVERY, when you have ' +
      'no handle on where something lives. When you already hold a message id, permalink, ' +
      'channel or user, read the source directly (read_channel / read_dm / read_pins) instead: ' +
      'search returns scattered single messages, never a whole conversation. Returns [m:<id>] ' +
      '(in <channelID>) snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max hits (≤20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_reaction',
    description:
      'React to a message [m:<id>] with a normal emoji (e.g. 👍 🎉). Defaults to the thread you ' +
      'were invoked in; pass channelID when reacting elsewhere. Status emojis (👀⚙️✅…) are ' +
      'reserved — use set_state for those.',
    inputSchema: {
      type: 'object',
      properties: {
        messageID: { type: 'string' },
        emoji: { type: 'string', description: 'The emoji character itself.' },
        channelID: { type: 'string', description: 'Only when the message is in another channel.' },
      },
      required: ['messageID', 'emoji'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_users',
    description:
      'Search the workspace directory by name. Returns [u:<userID>] Name lines — the IDs feed ' +
      'send_dm; the names can be @mentioned in posts.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name fragment; empty lists everyone.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'send_dm',
    description:
      'Send a direct message to one user [u:<id>], in the DM between THEM and YOUR INVOKER ' +
      '(you post as yourself, on the invoker\'s behalf — the recipient sees who asked). Shares ' +
      'your per-task post cap. Consider request_approval first unless the invoker explicitly ' +
      'asked you to DM someone.',
    inputSchema: {
      type: 'object',
      properties: {
        userID: { type: 'string' },
        body: { type: 'string', description: 'Message text (markdown).' },
      },
      required: ['userID', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_reply',
    description:
      'Draft a reply for your CREATOR to approve, edit, or cancel — the reply-mode watcher path. ' +
      'You do NOT post; on approval the system posts your text (or their edit) in the thread. Pass ' +
      'the full reply as `text`, and thread_root = the [m:<id>] of the message you are answering so ' +
      'it lands in that thread. Use this instead of post_message when you are a reply-mode watcher.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The full drafted reply (markdown).' },
        thread_root: { type: 'string', description: "Message ID of the thread to reply in (the question's [m:<id>])." },
        reply_to: { type: 'string', description: 'Optional: the [m:<id>] you are answering, shown to your creator for context.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_spill',
    description:
      'Read more of a SPILLED tool result. When a tool returns too much to show inline, you get a ' +
      'preview plus a locator like sp-3 — the full data is stored for this run. Fetch the part you ' +
      `need by character offset (each call returns up to ${SPILL_FETCH_MAX} chars and tells you the ` +
      'next offset). Fetch only what the task requires; do not page through everything by default.',
    inputSchema: {
      type: 'object',
      properties: {
        locator: { type: 'string', description: 'The spill locator from the preview, e.g. "sp-3".' },
        offset: { type: 'number', description: 'Character offset to read from (default 0).' },
        length: { type: 'number', description: `Chars to read (default and max ${SPILL_FETCH_MAX}).` },
      },
      required: ['locator'],
      additionalProperties: false,
    },
  },
  {
    name: 'use_connector',
    description:
      'Attach one of the invoker\'s INSTALLED connectors (listed in your context under ' +
      '"Installed connectors") to this task, when the task clearly needs that external ' +
      'service and it was not already attached. Give the slug and a one-line reason — the ' +
      'invoker may be asked to approve. On success you get the service map inline and ' +
      'connector_lookup/connector_call work — go straight to connector_lookup with words from ' +
      'the question. Do NOT use this for services that are not in the installed list.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: "Installed connector slug, e.g. 'cliffhub'." },
        reason: { type: 'string', description: 'One line: why this task needs the service.' },
      },
      required: ['connector', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'connector_call',
    description:
      'Call a connected external service API (the /connector picked for this task). This is the ' +
      'ONLY way to reach these services — auth is handled for you, no shell or curl needed, and ' +
      'no approval is required for reads. Find the endpoint with connector_lookup FIRST (it ' +
      'returns the contract block and the valid enum values), then call it. Large JSON responses ' +
      'are SAVED TO A LOCAL FILE — the result shows pagination meta + key shape only; extract ' +
      'the fields you need from the saved file with capped shell commands, and take counts from ' +
      'meta (never read the whole file). Use query for query-string params (filters, per_page — ' +
      'keep pages small) and body for JSON bodies. Destructive calls (DELETE, or anything the ' +
      'docs mark irreversible) need request_approval FIRST.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: "Connector slug, e.g. 'cliffhub'." },
        method: { type: 'string', description: 'HTTP method (GET default, POST, PATCH, PUT, DELETE).' },
        path: { type: 'string', description: "Endpoint path exactly as in the docs, e.g. 'api/people/employees'." },
        query: {
          type: 'object',
          description: 'Query-string parameters as string values.',
          additionalProperties: { type: 'string' },
        },
        body: { type: 'object', description: 'JSON request body for POST/PATCH/PUT.' },
      },
      required: ['connector', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'connector_lookup',
    description:
      'Find endpoints in an ATTACHED connector and read their contracts in ONE step — replaces ' +
      'grepping _catalog.tsv, reading service .yaml files and _enums.yaml by hand. Pass query ' +
      '(words from the question) to search the catalog: you get the matching rows (route_id, ' +
      'METHOD path, side effects, summary); a query with exactly one hit also returns that ' +
      "endpoint's full contract block with every enum it references inlined. Pass route_id to get " +
      'the contract of a specific endpoint. Optional service scopes the search to one route prefix ' +
      '(e.g. "meetings"). Internal (machine-to-machine) endpoints are never returned.',
    inputSchema: {
      type: 'object',
      properties: {
        connector: { type: 'string', description: "Attached connector slug, e.g. 'cliffhub'." },
        query: { type: 'string', description: "Words from the question, e.g. 'meetings today calendar'." },
        route_id: { type: 'string', description: "Exact route id from the catalog, e.g. 'meetings.upcoming'." },
        service: { type: 'string', description: "Optional route prefix to scope the search, e.g. 'one_on_ones'." },
      },
      required: ['connector'],
      additionalProperties: false,
    },
  },
  {
    name: 'link_message',
    description:
      'Turn a message reference into a CLICKABLE permalink you can paste into your reply. Give the ' +
      "message_id (a bare id or an [m:<id>] marker). It links a message in your CURRENT channel by " +
      'default; pass channel_id ([ch:<id>]) or conversation_id to link one elsewhere, and ' +
      'thread_root if it lives in a thread. Returns a URL that renders as a quoted-message card in ' +
      'chat — ALWAYS prefer this over pasting a raw [m:<id>] marker when a human asked for a link.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message to link (bare id or [m:<id>]).' },
        channel_id: { type: 'string', description: 'Optional channel ([ch:<id>]) if not the current one.' },
        conversation_id: { type: 'string', description: 'Optional DM/conversation id if linking a DM.' },
        thread_root: { type: 'string', description: 'Optional [m:<id>] of the thread root, if the message is a reply.' },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify_owner',
    description:
      'Send a PRIVATE heads-up to YOUR CREATOR (the person you run for) — lands in your DM with ' +
      'them, never in the watched channel. This is how a watcher "DMs me". In notify/draft mode ' +
      'this is the only way to communicate; public posts are blocked.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string', description: 'The message to your creator (markdown).' } },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_reminder',
    description:
      'Set a reminder for YOUR INVOKER — it fires into their activity + notifications at the ' +
      'given time, anchored to a message in this thread. Give in_minutes (minutes from now) OR ' +
      'remind_at (RFC3339 UTC). Defaults to the message that invoked you; pass message_id to ' +
      'anchor a different one. This is the invoker\'s own reminder, not a message to them.',
    inputSchema: {
      type: 'object',
      properties: {
        in_minutes: { type: 'number', description: 'Minutes from now, e.g. 5.' },
        remind_at: { type: 'string', description: 'Absolute time, RFC3339 e.g. 2026-08-13T15:04:05Z.' },
        message_id: { type: 'string', description: 'Message to remind about; defaults to the invoking message.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_reminders',
    description: "List your invoker's pending reminders as [rem:<id>] time — preview lines.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_reminder',
    description: "Cancel one of your invoker's pending reminders by its [rem:<id>].",
    inputSchema: {
      type: 'object',
      properties: { reminder_id: { type: 'string' } },
      required: ['reminder_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'pin_message',
    description:
      'Pin (or unpin) a message [m:<id>] in the thread you were invoked in, on the invoker\'s ' +
      'behalf. Pass pinned:false to unpin.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        pinned: { type: 'boolean', description: 'true to pin (default), false to unpin.' },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description:
      'Ask the human who invoked you to pick ONE option when a decision is genuinely theirs — ' +
      'a tradeoff you cannot resolve from the thread (e.g. "quick summary vs full report", ' +
      '"claude vs codex"). BLOCKS until they choose or it times out. 2–5 short options. ' +
      'Do not use it for questions the thread already answers.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, one or two sentences.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: 'Mutually exclusive answers, ≤120 chars each.',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'approval_prompt',
    description:
      'Internal permission gateway used by the harness for tool-permission prompts. Do not call ' +
      'directly — use request_approval for your own approval needs.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
      additionalProperties: true,
    },
  },
  {
    name: 'claim_task',
    description:
      'Atomically lock one part of a shared task. MANDATORY whenever several agents were invoked ' +
      'together and the task divides into parts: claim BEFORE working or announcing anything, with ' +
      'a short label from the task\'s own words (e.g. "hindi", "auth.go"). First claim wins and the ' +
      'result is the only source of truth for who does what — if your label is taken, claim a ' +
      'different remaining part. Never state which part you took without holding its claim.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short name for the part you are taking (≤64 chars).' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_memory',
    description:
      'Replace your core memory for THIS invoker — a small private document injected into every ' +
      'future task you run for them. Keep it under ~8KB: durable preferences, ongoing projects, ' +
      'sharp lessons. Rewrite the WHOLE document (this replaces, not appends); evict finished ' +
      'work. Update it when you learn something that will matter beyond this task.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The complete new memory document (markdown).' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_coding_task',
    description:
      'Open a CODING TASK (fix a bug, build a feature, do a chore) for a PRODUCT — the only way ' +
      'to start coding work. project is the product name ("CliffHub"), NOT a repo path; repos ' +
      'are the GitLab repositories that make it up, each with a role (frontend, backend, …). ' +
      'Products usually span backend AND frontend — include both unless the ask is clearly ' +
      'one-sided. A product listed under "# Known coding projects" needs no repos (they are ' +
      'on record); a new one does — if you cannot name them, ask_user first, never guess. The ' +
      "server creates/reuses the requester's own private project channel (~product-<their name>, " +
      'shared only by invite), posts a pinned task card whose ' +
      'thread is the task\'s home, links back here, and starts the dev agent\'s task run there ' +
      'with every repo checked out. After it returns, END your turn without posting.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The PRODUCT name, e.g. "CliffHub" or "Booking Portal" (not a repo path).' },
        repos: {
          type: 'array',
          description: 'The product\'s GitLab repos with roles. Required for a product Ex has not seen; optional afterwards.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'GitLab path, e.g. "acme/web/shop-frontend".' },
              role: { type: 'string', enum: ['frontend', 'backend', 'mobile', 'infra', 'other'] },
              base_branch: { type: 'string', description: 'Base branch for this repo; omit for its default.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        title: { type: 'string', description: 'Short task title (≤120 chars), e.g. "Fix Feb-29 date picker crash".' },
        goal: { type: 'string', description: 'What to achieve and how to know it is done — repro steps, expected behavior, constraints. Keep it CRISP: 2-3 sentences of context plus requirement bullets. It becomes the task card and the MR fallback text — not the place for a spec dump.' },
        kind: { type: 'string', enum: ['bug', 'feature', 'chore'], description: 'Task kind (the flair).' },
        base_branch: { type: 'string', description: 'Default base branch for repos that do not name one.' },
        ticket: {
          type: 'object',
          description: 'Optional linked ticket (e.g. CliffHub).',
          properties: { connector: { type: 'string' }, id: { type: 'string' }, url: { type: 'string' } },
          additionalProperties: false,
        },
      },
      required: ['project', 'title', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_test_plan',
    description:
      'Coding task: the change is implemented, committed and verified locally — hand it to the ' +
      'requester to test THROUGH THE PRODUCT. Give: url = what they open (the product UI when the ' +
      'project has one — never an API endpoint), steps = numbered actions from THEIR perspective ' +
      '(who to sign in as, what to click, what they should see), counter_steps = what must NOT ' +
      'happen (the other role\'s view, the previous behavior that must stay the same), accounts = ' +
      'which test roles/users to use (no secrets). Pass servers (repo + command, e.g. backend ' +
      '"docker compose up" / frontend "npm run dev") and the runner STARTS and keeps them running ' +
      'while they test — do not start servers yourself. Moves the task to awaiting_user_test; ' +
      'END your turn right after.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'What the requester opens, e.g. http://localhost:3000/leaves.' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Ordered steps from the requester\'s perspective (1–12).' },
        counter_steps: { type: 'array', items: { type: 'string' }, description: 'What must NOT work / who must NOT see it / what must still work as before (≥1).' },
        accounts: { type: 'string', description: 'Roles/test users to use, e.g. "hr1@test.com (HR) and ica1@test.com (plain IC); passwords in the dev seed".' },
        notes: { type: 'string', description: 'Anything else worth knowing (data to look at, month to pick, …).' },
        servers: {
          type: 'array',
          description: 'Dev servers to start and keep running while the requester tests.',
          items: {
            type: 'object',
            properties: {
              repo: { type: 'string', description: 'Repo path (or its last segment) the command runs in.' },
              cmd: { type: 'string', description: 'Command, e.g. "npm run dev -- --port 3000" or "docker compose up".' },
              url: { type: 'string', description: 'URL to wait for (its port must open), e.g. http://localhost:8000.' },
            },
            required: ['repo', 'cmd'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps', 'counter_steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_mr',
    description:
      'Coding task: push the branch and open the GitLab merge request — ONLY after the requester ' +
      'has tested. If they signed off (task card) it proceeds; otherwise it asks them for approval ' +
      'first and waits. Commit everything before calling (a dirty tree is refused). Never run git ' +
      'push or open MRs yourself. Pass repo_notes (or summary): the reviewer-facing MR body — ' +
      'what changed and why. NEVER local setup, localhost URLs, seeded accounts/passwords, debug ' +
      'notes or test-plan steps; Ex appends the task link + signature itself.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'MR body for repos without a repo_notes entry: 3-8 reviewer-facing bullets, what changed and why.',
        },
        repo_notes: {
          type: 'array',
          description: 'Per-repo MR body — preferred when the repos changed differently.',
          items: {
            type: 'object',
            properties: {
              repo: { type: 'string', description: 'Repo path or its last segment, e.g. "cliffhub-2-frontend".' },
              note: { type: 'string', description: 'Reviewer-facing bullets for THIS repo.' },
            },
            required: ['repo', 'note'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task_state',
    description:
      'Coding task: post a lifecycle note in the task thread and/or move the task state. Use ' +
      'state "in_progress" once you start changing code, "setup_failed" when the project cannot ' +
      'be built/run and you need the requester (say why in note). Milestone notes ("Root cause: …") ' +
      'go through post_message, not here.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['in_progress', 'setup_failed', 'workspace_ready'] },
        note: { type: 'string', description: 'Optional one-line note for the thread.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'register_project_commands',
    description:
      'Coding task: remember what you learned about running ONE repo of this project — ' +
      'install/setup, test and dev-server commands, the dev port, short notes (how to sign in, ' +
      'which roles exist, seed data) — so the next task skips the discovery. Call once you have ' +
      'verified the commands actually work.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo path (or its last segment) these commands belong to.' },
        setup_cmd: { type: 'string' },
        test_cmd: { type: 'string' },
        dev_cmd: { type: 'string' },
        port: { type: 'number' },
        notes: { type: 'string', description: 'Gotchas (env vars needed, seed data, …), ≤500 chars.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_state',
    description:
      'Change your visible status emoji on the invoking message. ⚙️ is set for you automatically ' +
      'when you start — call this only to switch it (e.g. "🔍" while reviewing). Allowed: 👀 🧠 ⚙️ 🔍.',
    inputSchema: {
      type: 'object',
      properties: {
        // Unicode emoji — the backend validates against the same set the
        // chat UI renders (shortcode names would display as literal text).
        state: { type: 'string', enum: ['👀', '🧠', '⚙️', '🔍'] },
      },
      required: ['state'],
      additionalProperties: false,
    },
  },
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// toolText wraps a string as an MCP tool result; isError=true tells the
// model the call failed in a way it can reason about (retry vs give up).
// attachedResult is what the model reads right after use_connector succeeds.
// It carries the one connector-specific part of the server's _USAGE.md — the
// service map — inline and points at connector_lookup, so the agent's next
// turn is a lookup rather than a file read. The workflow rules that used to
// fill the rest of that doc live in the system prompt now (harness/shared.ts).
function attachedResult(slug: string, title: string, dir: string): string {
  const usage = readOptional(path.join(dir, '_USAGE.md'));
  const services = usage ? servicesFromUsage(usage) : [];
  const lines = [`attached: ${slug} (${title}).`];
  if (services.length > 0) {
    lines.push("Services (route prefixes for connector_lookup's service scope):", ...services.slice(0, 20));
  }
  lines.push(
    `Next: connector_lookup(connector: '${slug}', query: '<words from the question>') — one call returns ` +
      'the matching endpoints, the chosen contract and its enum values; then ONE complete connector_call.',
    `Who the invoker is on this service: ${path.join(dir, '_identity.json')} (grep the one field you need). ` +
      `Full docs: ${dir} — only for what lookup cannot answer.`,
  );
  return lines.join('\n');
}

function toolResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

// Spill: oversized tool results are stored server-side and replaced with a
// head/tail preview + a fetch_spill locator — the model pages through the
// full data instead of losing it to truncation. One store per run (this
// process is per-run).
const spills = new SpillStore();

// applySpill routes every successful tool result through the spill store.
// Errors stay verbatim (they're short and must not be rewritten); fetch_spill
// output is already a bounded slice and must never re-spill itself.
function applySpill(name: string, result: Record<string, unknown>): Record<string, unknown> {
  // approval_prompt replies are the CLI's permission-JSON protocol frames —
  // spilling one corrupts the contract and fails the gated tool call.
  if (name === 'fetch_spill' || name === 'approval_prompt' || result.isError) return result;
  const content = result.content as Array<{ type?: string; text?: string }> | undefined;
  const text = content?.[0]?.text;
  if (typeof text !== 'string') return result;
  const out = spills.maybeSpill(name, text);
  if (out === text) return result;
  return toolResult(out);
}

// Saved API responses: large JSON bodies land on disk (responses/ beside the
// run cwd) instead of in the prompt — the tool result carries only pagination
// meta + key shape, and the agent extracts fields from the file with capped
// shell commands. Files persist with the thread workdir, so warm follow-ups
// can re-read earlier results for free.
let responseSeq = 0;

function saveResponse(slug: string, text: string): string | null {
  try {
    const dir = path.join(WORK_DIR, 'responses');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slug}-${++responseSeq}.json`);
    fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch {
    return null; // unwritable disk → caller falls back to the spill store
  }
}

// shapeSummary renders a JSON body's structure without its bulk: scalar and
// small-object top-level values verbatim (pagination meta survives whole),
// arrays as length + first-item keys. Returns null for non-JSON.
function shapeSummary(text: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const itemKeys = (arr: unknown[]): string => {
    const first = arr[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return '';
    return ` — item keys: ${Object.keys(first as object).slice(0, 25).join(',')}`;
  };
  if (Array.isArray(v)) return `array[${v.length}]${itemKeys(v)}`;
  if (!v || typeof v !== 'object') return null;
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      parts.push(`${k}: array[${val.length}]${itemKeys(val)}`);
    } else if (val && typeof val === 'object') {
      const s = JSON.stringify(val);
      parts.push(s.length <= 400 ? `${k}: ${s}` : `${k}: object(${Object.keys(val).length} keys)`);
    } else {
      parts.push(`${k}: ${JSON.stringify(val)}`);
    }
  }
  return parts.join('\n').slice(0, 1600);
}

let postSeq = 0;

async function callBackend(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${RUN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // empty/non-JSON body
  }
  // The backend wraps rejections as {error: {code, message}} — hoist the pair
  // so every reader (describeFailure, the per-tool 409 branches) sees flat
  // `error` (the code) and `message` fields.
  return { ok: res.ok, status: res.status, data: flattenBackendError(data) };
}

// describeFailure turns a backend rejection into an actionable, structured
// message for the model: a permission denial should not be retried; a closed
// run means stop entirely.
function describeFailure(status: number, data: Record<string, unknown>): string {
  const msg = typeof data.message === 'string' ? data.message : `HTTP ${status}`;
  if (status === 409) {
    // 409s carry a code (handler contract): only run_closed means down tools.
    if (data.error === 'run_closed') return `run is closed; stop all further work (${msg}) [retryable=false]`;
    return `blocked: ${msg} — this step is out of order; do a different step, don't just retry [retryable=false]`;
  }
  if (status === 403) return `not permitted: ${msg} [retryable=false]`;
  if (status === 429) return `rate limited or post cap reached: ${msg} [retryable=false]`;
  return `failed: ${msg} [retryable=${status >= 500}]`;
}

// awaitApproval opens an approval (plain, or multiple-choice when options
// are given) and blocks-by-polling until the invoker decides or the backend
// expires it (plan-v2 §7) — shared by request_approval, ask_user, and the
// harness's approval_prompt permission gateway.
type ApprovalVerdict =
  | { state: 'approved' | 'denied' | 'expired'; choice?: string; note?: string; approvalID: string }
  | { error: string };

async function awaitApproval(
  summary: string,
  risk: string,
  options?: string[],
  toolKind?: string,
): Promise<ApprovalVerdict> {
  const created = await callBackend('POST', '/api/v1/agent/run/approvals', { summary, risk, options, toolKind });
  if (!created.ok) return { error: describeFailure(created.status, created.data) };
  return pollApproval(String(created.data.approvalID), Date.parse(String(created.data.deadline)));
}

// pollApproval waits on an EXISTING approval — the gates the backend raises
// itself (use_connector, request_mr), where the card's text and its purpose
// are the server's, not the model's.
async function pollApproval(approvalID: string, deadlineMs = NaN): Promise<ApprovalVerdict> {
  let deadline = deadlineMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await callBackend('GET', `/api/v1/agent/run/approvals/${approvalID}`);
    if (!res.ok) return { error: describeFailure(res.status, res.data) };
    const state = String(res.data.state);
    if (state === 'approved' || state === 'denied' || state === 'expired') {
      return {
        state,
        approvalID,
        choice: typeof res.data.choice === 'string' && res.data.choice ? res.data.choice : undefined,
        // The invoker's typed direction ("no — use the seed DB instead").
        note: typeof res.data.note === 'string' && res.data.note ? res.data.note : undefined,
      };
    }
    if (!Number.isFinite(deadline)) {
      const d = Date.parse(String(res.data.deadline));
      if (Number.isFinite(d)) deadline = d;
    }
    if (Number.isFinite(deadline) && Date.now() > deadline + 15_000) return { state: 'expired', approvalID };
  }
}

// taskRepoFor resolves a repo reference (full path or its last segment) to
// one of the task's checkouts.
function taskRepoFor(ref: string): TaskRepoEnv | undefined {
  const r = ref.trim().replace(/\/+$/, '');
  if (!r) return undefined;
  return TASK_REPOS.find((x) => x.path === r) ?? TASK_REPOS.find((x) => x.path.split('/').pop() === r.split('/').pop());
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'post_message': {
      const raw = typeof args.body === 'string' ? args.body : '';
      // Models pad with runs of blank lines; in chat that renders as big
      // empty gaps. Collapse to one blank line — paragraph breaks survive.
      const body = raw.replace(/\n{3,}/g, '\n\n').trim();
      if (!body) return toolResult('post_message requires a non-empty body', true);
      postSeq += 1;
      const res = await callBackend('POST', '/api/v1/agent/run/messages', {
        body,
        // Idempotency: a network retry of the same logical post must not
        // double-post (plan-v2 §7). Sequence-scoped to this process = run.
        idempotencyKey: `mcp-${postSeq}`,
      });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const remaining = typeof res.data.remainingPosts === 'number' ? res.data.remainingPosts : '?';
      return toolResult(`posted (messageID=${String(res.data.messageID)}, remaining posts: ${remaining})`);
    }
    case 'get_thread': {
      const res = await callBackend('GET', '/api/v1/agent/run/thread');
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const text = typeof res.data.text === 'string' ? res.data.text : '';
      return toolResult(text.length > 0 ? text : '(thread is empty)');
    }
    case 'get_context': {
      const res = await callBackend('GET', '/api/v1/agent/run/context');
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const text = typeof res.data.text === 'string' ? res.data.text : '';
      return toolResult(text.length > 0 ? text : '(context is empty)');
    }
    case 'write_shared_context': {
      const body = typeof args.body === 'string' ? args.body : '';
      if (!body.trim()) return toolResult('write_shared_context requires a non-empty body', true);
      const res = await callBackend('POST', '/api/v1/agent/run/context', {
        body,
        pinned: args.pinned === true,
      });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(`stored (itemID=${String(res.data.itemID)})`);
    }
    case 'request_approval': {
      const summary = typeof args.summary === 'string' ? args.summary : '';
      if (!summary.trim()) return toolResult('request_approval requires a summary', true);
      const verdict = await awaitApproval(summary, typeof args.risk === 'string' ? args.risk : '');
      if ('error' in verdict) return toolResult(verdict.error, true);
      if (verdict.state === 'approved') {
        return toolResult(`approved — proceed with the action${verdict.note ? `. The invoker adds: ${verdict.note}` : ''}`);
      }
      if (verdict.state === 'denied') {
        return toolResult(
          verdict.note
            ? `denied by the invoker — do NOT take the action. They say: ${verdict.note} — follow that instead [retryable=false]`
            : 'denied by the invoker — do NOT take the action; explain and wind down [retryable=false]',
          true,
        );
      }
      return toolResult('denied (approval_timeout) — nobody decided in time; do NOT take the action [retryable=false]', true);
    }
    case 'ask_user': {
      const question = typeof args.question === 'string' ? args.question : '';
      const options = Array.isArray(args.options) ? args.options.filter((o) => typeof o === 'string') : [];
      if (!question.trim() || options.length < 2) {
        return toolResult('ask_user requires a question and 2–5 options', true);
      }
      const verdict = await awaitApproval(question, '', options as string[]);
      if ('error' in verdict) return toolResult(verdict.error, true);
      if (verdict.state === 'approved' && verdict.choice) {
        return toolResult(`the invoker chose: ${verdict.choice}${verdict.note ? ` — and adds: ${verdict.note}` : ''}`);
      }
      if (verdict.state === 'denied') {
        return toolResult(
          verdict.note
            ? `the invoker answered in their own words instead: ${verdict.note}`
            : 'the invoker dismissed the question — decide sensibly yourself and say which assumption you made',
          true,
        );
      }
      return toolResult('no answer in time — decide sensibly yourself and say which assumption you made', true);
    }
    case 'approval_prompt': {
      // The harness's permission gateway (claude --permission-prompt-tool):
      // every native-tool permission request (Bash, Write, WebSearch, …)
      // lands here and becomes an approval card for the invoker. The reply
      // is the JSON contract the CLI expects, as text content.
      const toolName = typeof args.tool_name === 'string' ? args.tool_name : 'unknown tool';
      const input = (args.input as Record<string, unknown> | undefined) ?? {};
      // Task permission profile: inside a coding task's checkout, routine
      // coding work (edits, package managers, tests, local git) is
      // auto-approved — the approval card is for what reaches outside the
      // workspace. The harness still records every call on the timeline.
      let policyReason = '';
      if (TASK_ID && TASK_DIR) {
        const decision = taskPolicyAllows(toolName, input, { taskDir: TASK_DIR, stateDir: WORK_DIR });
        if (decision.allow) {
          // No updatedInput: omitting it means "run with the original input",
          // and echoing a large Write back made the reply itself big enough to
          // hit the spill/clip layer — which corrupts the permission JSON.
          return toolResult(JSON.stringify({ behavior: 'allow' }));
        }
        policyReason = decision.reason;
      }
      // The invoker's standing "always allow <class> for this agent".
      const cls = toolClass(toolName);
      if (cls && AUTO_ALLOW.has(cls)) {
        return toolResult(JSON.stringify({ behavior: 'allow' }));
      }
      // Say WHY the card was raised — "asked because: unrecognized command …"
      // tells the invoker (and us, when debugging) which rule fired.
      const summaryText = describeToolUse(toolName, input) + (policyReason ? ` — asked because: ${policyReason}` : '');
      const verdict = await awaitApproval(summaryText, 'tool', undefined, cls || undefined);
      const allow = !('error' in verdict) && verdict.state === 'approved';
      // A denial carries the invoker's direction (Claude Code's "no, and tell
      // it what to do differently") so the model changes course instead of
      // retrying blindly.
      const note = 'error' in verdict ? '' : verdict.note ?? '';
      return toolResult(
        JSON.stringify(
          allow
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: note ? `The invoker denied this and says: ${note}` : 'The invoker denied this tool use.' },
        ),
      );
    }
    case 'list_channels': {
      const res = await callBackend('GET', '/api/v1/agent/run/channels');
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : '');
    }
    case 'create_channel': {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!name.trim()) return toolResult('create_channel requires a name', true);
      const res = await callBackend('POST', '/api/v1/agent/run/channels', {
        name,
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(`created ~${name} (channelID=${String(res.data.channelID)})`);
    }
    case 'join_channel': {
      const channelID = typeof args.channelID === 'string' ? args.channelID : '';
      if (!channelID) return toolResult('join_channel requires channelID', true);
      const res = await callBackend('POST', `/api/v1/agent/run/channels/${encodeURIComponent(channelID)}/join`);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult('joined');
    }
    case 'read_channel': {
      const channelID = typeof args.channelID === 'string' ? args.channelID : '';
      if (!channelID) return toolResult('read_channel requires channelID', true);
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 30;
      const thread = typeof args.thread === 'string' && args.thread ? `&thread=${encodeURIComponent(args.thread)}` : '';
      const res = await callBackend(
        'GET',
        `/api/v1/agent/run/channels/${encodeURIComponent(channelID)}/messages?limit=${String(limit)}${thread}`,
      );
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const text = typeof res.data.text === 'string' ? res.data.text : '';
      return toolResult(text.length > 0 ? text : '(no messages)');
    }
    case 'read_pins': {
      const channelID = typeof args.channelID === 'string' ? args.channelID : '';
      if (!channelID) return toolResult('read_pins requires channelID', true);
      const res = await callBackend(
        'GET',
        `/api/v1/agent/run/channels/${encodeURIComponent(channelID)}/pins`,
      );
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const text = typeof res.data.text === 'string' ? res.data.text : '';
      return toolResult(text.length > 0 ? text : '(no pinned messages)');
    }
    case 'read_dm': {
      const userID = typeof args.userID === 'string' ? args.userID : '';
      if (!userID) return toolResult('read_dm requires userID', true);
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 30;
      const thread = typeof args.thread === 'string' && args.thread ? `&thread=${encodeURIComponent(args.thread)}` : '';
      const res = await callBackend(
        'GET',
        `/api/v1/agent/run/dm/${encodeURIComponent(userID)}/messages?limit=${String(limit)}${thread}`,
      );
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const text = typeof res.data.text === 'string' ? res.data.text : '';
      return toolResult(text.length > 0 ? text : '(no messages with that user)');
    }
    case 'post_to_channel': {
      const channelID = typeof args.channelID === 'string' ? args.channelID : '';
      const body = typeof args.body === 'string' ? args.body : '';
      if (!channelID || !body.trim()) return toolResult('post_to_channel requires channelID and body', true);
      const payload: Record<string, unknown> = { body };
      if (typeof args.thread_root === 'string' && args.thread_root) payload.thread_root = args.thread_root;
      const res = await callBackend(
        'POST',
        `/api/v1/agent/run/channels/${encodeURIComponent(channelID)}/messages`,
        payload,
      );
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const remaining = typeof res.data.remainingPosts === 'number' ? res.data.remainingPosts : '?';
      return toolResult(`posted (messageID=${String(res.data.messageID)}, remaining posts: ${remaining})`);
    }
    case 'search_messages': {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) return toolResult('search_messages requires a query', true);
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, 20) : 10;
      const res = await callBackend(
        'GET',
        `/api/v1/agent/run/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`,
      );
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : '(no results)');
    }
    case 'add_reaction': {
      const messageID = typeof args.messageID === 'string' ? args.messageID : '';
      const emoji = typeof args.emoji === 'string' ? args.emoji : '';
      if (!messageID || !emoji) return toolResult('add_reaction requires messageID and emoji', true);
      const payload: Record<string, unknown> = { messageID, emoji };
      if (typeof args.channelID === 'string' && args.channelID) {
        payload.parentID = args.channelID;
        payload.parentType = 'channel';
      }
      const res = await callBackend('POST', '/api/v1/agent/run/reactions', payload);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult('reaction toggled');
    }
    case 'list_users': {
      const query = typeof args.query === 'string' ? args.query : '';
      const res = await callBackend('GET', `/api/v1/agent/run/users?q=${encodeURIComponent(query)}`);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : '(no matching users)');
    }
    case 'send_dm': {
      const userID = typeof args.userID === 'string' ? args.userID : '';
      const body = typeof args.body === 'string' ? args.body : '';
      if (!userID || !body.trim()) return toolResult('send_dm requires userID and body', true);
      const res = await callBackend('POST', '/api/v1/agent/run/dm', { userID, body });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const remaining = typeof res.data.remainingPosts === 'number' ? res.data.remainingPosts : '?';
      return toolResult(`sent (messageID=${String(res.data.messageID)}, remaining posts: ${remaining})`);
    }
    case 'propose_reply': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text.trim()) return toolResult('propose_reply requires text (your drafted reply)', true);
      const payload: Record<string, unknown> = { text };
      if (typeof args.thread_root === 'string' && args.thread_root) payload.thread_root = args.thread_root;
      if (typeof args.reply_to === 'string' && args.reply_to) payload.reply_to = args.reply_to;
      const res = await callBackend('POST', '/api/v1/agent/run/propose-reply', payload);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : 'reply drafted for approval');
    }
    case 'fetch_spill': {
      const locator = typeof args.locator === 'string' ? args.locator : '';
      if (!locator) return toolResult('fetch_spill requires locator', true);
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const length = typeof args.length === 'number' ? args.length : SPILL_FETCH_MAX;
      const out = spills.fetch(locator, offset, length);
      return toolResult(out.text, out.isError);
    }
    case 'use_connector': {
      const slug = typeof args.connector === 'string' ? args.connector : '';
      const reason = typeof args.reason === 'string' ? args.reason : '';
      if (!slug.trim() || !reason.trim()) return toolResult('use_connector requires connector and reason', true);
      if (CONNECTORS.has(slug)) return toolResult(`${slug} is already attached — call connector_call directly`);

      const first = await callBackend('POST', '/api/v1/agent/run/use-connector', { connector: slug, reason });
      if (!first.ok) return toolResult(describeFailure(first.status, first.data), true);
      let status = String(first.data.status);
      const title = typeof first.data.title === 'string' ? first.data.title : slug;

      if (status === 'ask') {
        // Consent gate. The BACKEND raises the card and hands back its id, so
        // the approval it later verifies is the one the human actually saw —
        // nothing the model writes can stand in for it. An older server sends
        // no id, and we compose the card ourselves as before.
        const serverGate = typeof first.data.approvalID === 'string' ? first.data.approvalID : '';
        const gateSummary = typeof first.data.summary === 'string' && first.data.summary
          ? first.data.summary
          : `Use the ${title} connector (${slug}) for this task: ${reason}`;
        const verdict = serverGate
          ? await pollApproval(serverGate)
          : await awaitApproval(gateSummary, '');
        if ('error' in verdict) return toolResult(verdict.error, true);
        if (verdict.state !== 'approved') {
          return toolResult(
            `the invoker did not approve using ${slug} — do NOT try to reach this service another way; ` +
              'answer from what you have or say what is missing [retryable=false]',
            true,
          );
        }
        const second = await callBackend('POST', '/api/v1/agent/run/use-connector', {
          connector: slug,
          reason,
          approvalID: verdict.approvalID,
        });
        if (!second.ok) return toolResult(describeFailure(second.status, second.data), true);
        status = String(second.data.status);
      }

      if (status !== 'attached') {
        const msg = String(first.data.message ?? 'connector not available');
        return toolResult(`${msg} — do NOT try to reach this service another way [retryable=false]`, true);
      }

      // Attached server-side — pull the payload, sync docs beside the run's
      // cwd, and arm connector_call with the credential.
      try {
        const rows = await fetchRunConnectors(BASE_URL, RUN_TOKEN);
        syncConnectors(path.join(WORK_DIR, 'connectors'), rows, () => {});
        for (const r of rows) {
          CONNECTORS.set(r.slug, { slug: r.slug, title: r.title, baseURL: r.baseURL, token: r.token, authHeader: r.authHeader });
        }
        const dir = path.join(WORK_DIR, 'connectors', slug);
        return toolResult(attachedResult(slug, title, dir));
      } catch (err) {
        return toolResult(`attached, but doc sync failed: ${String(err)} — retry use_connector once`, true);
      }
    }
    case 'connector_lookup': {
      const slug = typeof args.connector === 'string' ? args.connector : '';
      if (!CONNECTORS.has(slug)) {
        const have = [...CONNECTORS.keys()].join(', ') || 'none';
        return toolResult(`"${slug}" is not attached to this task (attached: ${have}) — call use_connector first`, true);
      }
      const out = lookup({
        dir: path.join(WORK_DIR, 'connectors', slug),
        slug,
        query: typeof args.query === 'string' ? args.query : undefined,
        routeId: typeof args.route_id === 'string' ? args.route_id : undefined,
        service: typeof args.service === 'string' ? args.service : undefined,
      });
      return toolResult(out.text, out.isError);
    }
    case 'connector_call': {
      const slug = typeof args.connector === 'string' ? args.connector : '';
      const cred = CONNECTORS.get(slug);
      if (!cred) {
        const have = [...CONNECTORS.keys()].join(', ') || 'none';
        return toolResult(`unknown connector "${slug}" — attached to this task: ${have}`, true);
      }
      const method = (typeof args.method === 'string' && args.method ? args.method : 'GET').toUpperCase();
      if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
        return toolResult(`unsupported method ${method}`, true);
      }
      // Gated watcher modes are read-only against external services too —
      // deterministic, matching the hidden posting surface.
      if (GATED && method !== 'GET') {
        return toolResult(`this ${ACTION_MODE} run is read-only: only GET calls are allowed`, true);
      }
      const rawPath = typeof args.path === 'string' ? args.path : '';
      if (!rawPath.trim() || rawPath.includes('://')) {
        return toolResult('path must be a relative endpoint path from the docs (no host)', true);
      }
      // URL is pinned to the connector's base — the token can go nowhere else.
      const url = new URL(`${cred.baseURL.replace(/\/+$/, '')}/${rawPath.replace(/^\/+/, '')}`);
      if (args.query && typeof args.query === 'object') {
        for (const [k, v] of Object.entries(args.query as Record<string, unknown>)) {
          url.searchParams.set(k, String(v));
        }
      }
      try {
        const res = await fetch(url, {
          method,
          headers: {
            // Anonymous connectors (auth kind "none") ship an empty token —
            // send no credential header rather than a bare "Bearer ". The
            // header shape is the connector's (Metabase: X-Api-Key).
            ...(cred.token ? Object.fromEntries([credentialHeader(cred.authHeader, cred.token)]) : {}),
            accept: 'application/json',
            ...(args.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: args.body === undefined ? undefined : JSON.stringify(args.body),
        });
        const text = await res.text();
        const head = `HTTP ${res.status} — ${method} ${url.pathname}${url.search} (${text.length} chars)`;
        // Audit trail: every raw response is published as a run artifact so
        // the invoker can inspect what the agent actually saw (the drawer's
        // "API responses" section) — agents summarize; humans can verify.
        // Best-effort and non-blocking: the tool result never waits on it.
        void callBackend('POST', '/api/v1/agent/run/artifacts', {
          kind: 'api_response',
          title: `${method} ${url.pathname}${url.search.slice(0, 120)} → ${res.status}`,
          content: text.slice(0, 63 * 1024) || '(empty body)',
        }).catch(() => {});
        if (res.status === 401) {
          return toolResult(`${head}\nThe stored ${cred.title} credential was rejected — tell the invoker to reconnect the ${slug} connector. Do not retry.`, true);
        }
        // Non-2xx still returns the body (error envelopes carry the reason).
        // Success bodies flow through the spill store; error bodies bypass it
        // (applySpill leaves errors verbatim) so clip them defensively.
        if (res.status >= 400) {
          return toolResult(`${head}\n${text.slice(0, 4000)}`, true);
        }
        // Large JSON never rides the prompt: save it locally and return only
        // pagination meta + key shape. The agent extracts the few fields it
        // needs from the file with capped shell commands — same pattern as
        // _identity.json. Non-JSON (or unwritable disk) falls back to the
        // spill store.
        if (text.length > 1500) {
          const summary = shapeSummary(text);
          const saved = summary ? saveResponse(slug, text) : null;
          if (summary && saved) {
            return toolResult(
              `${head} → saved: ${saved}\n${summary}\n` +
                `[Full body is in the saved file. Extract ONLY the fields you need with capped ` +
                `shell commands (grep/python | head); counts come from the meta above. Do NOT ` +
                `read or cat the whole file. A 200 is not proof your filter applied — first ` +
                `CHECK the result matches your request (does the total fit your filter? do the ` +
                `rows carry the value you filtered on?); if it looks off, probe the saved file ` +
                `to see why before concluding or trying another call.]`,
            );
          }
        }
        return toolResult(`${head}\n${text}`);
      } catch (err) {
        return toolResult(`connector_call failed before reaching ${slug}: ${String(err)}`, true);
      }
    }
    case 'link_message': {
      const messageID = typeof args.message_id === 'string' ? args.message_id : '';
      if (!messageID.trim()) return toolResult('link_message requires message_id', true);
      const payload: Record<string, unknown> = { message_id: messageID };
      if (typeof args.channel_id === 'string' && args.channel_id) payload.channel_id = args.channel_id;
      if (typeof args.conversation_id === 'string' && args.conversation_id) payload.conversation_id = args.conversation_id;
      if (typeof args.thread_root === 'string' && args.thread_root) payload.thread_root = args.thread_root;
      const res = await callBackend('POST', '/api/v1/agent/run/link-message', payload);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.url === 'string' ? res.data.url : String(res.data.text ?? 'link built'));
    }
    case 'notify_owner': {
      const body = typeof args.body === 'string' ? args.body : '';
      if (!body.trim()) return toolResult('notify_owner requires body', true);
      const res = await callBackend('POST', '/api/v1/agent/run/notify', { body });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : 'notified your creator');
    }
    case 'set_reminder': {
      const payload: Record<string, unknown> = {};
      if (typeof args.in_minutes === 'number') payload.in_minutes = args.in_minutes;
      if (typeof args.remind_at === 'string' && args.remind_at) payload.remind_at = args.remind_at;
      if (typeof args.message_id === 'string' && args.message_id) payload.message_id = args.message_id;
      if (payload.in_minutes === undefined && payload.remind_at === undefined)
        return toolResult('set_reminder requires in_minutes or remind_at', true);
      const res = await callBackend('POST', '/api/v1/agent/run/reminders', payload);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : 'reminder set');
    }
    case 'list_reminders': {
      const res = await callBackend('GET', '/api/v1/agent/run/reminders');
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : '(no pending reminders)');
    }
    case 'cancel_reminder': {
      const id = typeof args.reminder_id === 'string' ? args.reminder_id : '';
      if (!id) return toolResult('cancel_reminder requires reminder_id', true);
      const res = await callBackend('DELETE', `/api/v1/agent/run/reminders/${encodeURIComponent(id)}`);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : 'reminder canceled');
    }
    case 'pin_message': {
      const messageID = typeof args.message_id === 'string' ? args.message_id : '';
      if (!messageID) return toolResult('pin_message requires message_id', true);
      const payload: Record<string, unknown> = { message_id: messageID };
      if (typeof args.pinned === 'boolean') payload.pinned = args.pinned;
      const res = await callBackend('POST', '/api/v1/agent/run/pins', payload);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(typeof res.data.text === 'string' ? res.data.text : 'pinned');
    }
    case 'publish_artifact': {
      const title = typeof args.title === 'string' ? args.title : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!title.trim() || !content.trim()) {
        return toolResult('publish_artifact requires title and content', true);
      }
      const res = await callBackend('POST', '/api/v1/agent/run/artifacts', {
        kind: typeof args.kind === 'string' ? args.kind : 'text',
        title,
        content,
      });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(
        `published (artifactID=${String(res.data.artifactID)}) — visible in this run's activity drawer; ` +
          'reference it by title in your reply',
      );
    }
    case 'list_skills': {
      const res = await callBackend('GET', '/api/v1/agent/run/skills');
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const skills = Array.isArray(res.data.skills) ? (res.data.skills as Record<string, unknown>[]) : [];
      if (skills.length === 0) return toolResult('(no skills defined in this workspace)');
      const lines = skills.map(
        (s) => `[s:${String(s.id)}] ${String(s.name)} — ${String(s.description ?? '')}`,
      );
      return toolResult(lines.join('\n'));
    }
    case 'invoke_skill': {
      const skillID = typeof args.skillID === 'string' ? args.skillID : '';
      if (!skillID) return toolResult('invoke_skill requires skillID', true);
      const res = await callBackend('POST', `/api/v1/agent/run/skills/${encodeURIComponent(skillID)}`);
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(`# Skill: ${String(res.data.name)}\n\n${String(res.data.instructions)}`);
    }
    case 'claim_task': {
      const label = typeof args.label === 'string' ? args.label : '';
      if (!label.trim()) return toolResult('claim_task requires a label', true);
      const res = await callBackend('POST', '/api/v1/agent/run/claims', { label });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      const mine = res.data.mine === true;
      const claims = Array.isArray(res.data.claims) ? (res.data.claims as string[]) : [];
      const listing = claims.length ? `\ncurrent claims:\n${claims.map((c) => `- ${c}`).join('\n')}` : '';
      return toolResult(
        mine
          ? `claimed — this part is yours.${listing}`
          : `already taken — pick a DIFFERENT part.${listing}`,
      );
    }
    case 'create_coding_task': {
      const project = typeof args.project === 'string' ? args.project.trim() : '';
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const goal = typeof args.goal === 'string' ? args.goal.trim() : '';
      if (!project || !title || !goal) return toolResult('create_coding_task requires project, title and goal', true);
      const payload: Record<string, unknown> = { project, title, goal };
      if (Array.isArray(args.repos)) payload.repos = args.repos;
      if (typeof args.kind === 'string' && args.kind) payload.kind = args.kind;
      if (typeof args.base_branch === 'string' && args.base_branch) payload.base_branch = args.base_branch;
      if (args.ticket && typeof args.ticket === 'object') payload.ticket = args.ticket;
      const res = await callBackend('POST', '/api/v1/agent/run/coding-task', payload);
      if (!res.ok) {
        if (res.status === 409) {
          const msg = String(res.data.message ?? '');
          if (String(res.data.error ?? '') === 'project_unknown' || msg.includes('unknown project')) {
            return toolResult(
              `${msg || 'unknown project'} — ask the requester (ask_user or a plain question) which GitLab repositories make up this product and their roles (frontend/backend/…), then call create_coding_task again with repos [retryable=true]`,
              true,
            );
          }
          return toolResult(
            `${msg || 'this project already has an active task'} — tell the requester to steer that task in its thread instead of opening another [retryable=false]`,
            true,
          );
        }
        return toolResult(describeFailure(res.status, res.data), true);
      }
      return toolResult(String(res.data.text ?? 'task created'));
    }
    case 'publish_test_plan': {
      if (!TASK_ID || !TASK_DIR) return toolResult('publish_test_plan only works inside a coding task run', true);
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).filter((x) => typeof x === 'string') : [];
      const counter = Array.isArray(args.counter_steps) ? (args.counter_steps as unknown[]).filter((x) => typeof x === 'string') : [];
      const servers = Array.isArray(args.servers) ? (args.servers as { repo?: string; cmd?: string; url?: string }[]) : [];
      let extra = '';
      for (const sv of servers) {
        if (!sv || typeof sv.cmd !== 'string' || !sv.cmd.trim()) continue;
        const repo = taskRepoFor(typeof sv.repo === 'string' ? sv.repo : '');
        const cwd = repo?.dir ?? TASK_DIR;
        const name = repo ? repo.path.split('/').pop() ?? 'server' : 'server';
        try {
          const h = await startDevServer(sv.cmd.trim(), cwd, WORK_DIR, typeof sv.url === 'string' ? sv.url : undefined, () => {}, name);
          extra += ` ${name}: running (pid ${h.pid}, log ${h.logFile}).`;
          if (repo) updateProjectCommands(workspaceRoot(), repo.path, { devCmd: sv.cmd.trim() });
        } catch (err) {
          return toolResult(`dev server for ${name} failed: ${String(err instanceof Error ? err.message : err)} — fix it and call publish_test_plan again`, true);
        }
      }
      const res = await callBackend('POST', '/api/v1/agent/run/coding-task/test-plan', {
        url,
        steps,
        counter_steps: counter,
        accounts: typeof args.accounts === 'string' ? args.accounts : '',
        notes: typeof args.notes === 'string' ? args.notes : '',
      });
      if (!res.ok) {
        if (res.status === 400) return toolResult(`${String(res.data.message ?? 'invalid test plan')} — fix the plan and call publish_test_plan again`, true);
        return toolResult(describeFailure(res.status, res.data), true);
      }
      return toolResult(`${String(res.data.text ?? 'published')}${extra}`);
    }
    case 'request_mr': {
      if (!TASK_ID || !TASK_DIR) return toolResult('request_mr only works inside a coding task run', true);
      let res = await callBackend('POST', '/api/v1/agent/run/coding-task/request-mr', {});
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      let status = String(res.data.status ?? '');
      if (status === 'ask') {
        // The gate: the requester decides, on their own approval card. The
        // backend raises it and returns its id (see use_connector above).
        const summary = String(res.data.summary ?? 'Create the merge request(s) for this task');
        const serverGate = typeof res.data.approvalID === 'string' ? res.data.approvalID : '';
        const verdict = serverGate ? await pollApproval(serverGate) : await awaitApproval(summary, 'high');
        if ('error' in verdict) return toolResult(verdict.error, true);
        if (verdict.state !== 'approved') {
          return toolResult(
            `the requester did not sign off${verdict.note ? ` — they say: ${verdict.note}` : ''} — do NOT push; act on their feedback in the thread [retryable=false]`,
            true,
          );
        }
        res = await callBackend('POST', '/api/v1/agent/run/coding-task/request-mr', { approvalID: verdict.approvalID });
        if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
        status = String(res.data.status ?? '');
      }
      if (status !== 'approved') {
        return toolResult(`${String(res.data.message ?? status)} [retryable=false]`, true);
      }
      const cred = CONNECTORS.get('gitlab');
      if (!cred || !cred.token) {
        return toolResult(
          'no GitLab connector is attached to this run — the requester must install the gitlab connector (Connectors page) with a token that has api + write_repository scopes, then reply here to retry [retryable=false]',
          true,
        );
      }
      if (TASK_REPOS.length === 0) return toolResult('no repo checkouts are known for this run — report the workspace state first and retry', true);
      const host = gitHostFromBaseURL(cred.baseURL);
      const labels = Array.isArray(res.data.labels) ? (res.data.labels as string[]) : ['ex:dev'];
      // MR body: the agent's reviewer-facing note for the repo (repo_notes >
      // summary), else the server's short fallback — plus the Ex footer. The
      // old server-composed mrDescription (goal + test steps) leaked local
      // accounts and localhost URLs into forge MRs.
      const rawNotes = Array.isArray(args.repo_notes) ? (args.repo_notes as { repo?: string; note?: string }[]) : [];
      const noteFor = (repoPath: string): string => {
        for (const n of rawNotes) {
          if (!n || typeof n.repo !== 'string' || typeof n.note !== 'string' || !n.note.trim()) continue;
          if (n.repo === repoPath || repoPath.endsWith(`/${n.repo}`) || n.repo === repoPath.split('/').pop()) return n.note.trim();
        }
        return '';
      };
      const summaryArg = typeof args.summary === 'string' ? args.summary.trim() : '';
      const mrFooter = typeof res.data.mrFooter === 'string' ? res.data.mrFooter : '';
      const bodyFallback = typeof res.data.mrBodyFallback === 'string' ? res.data.mrBodyFallback : '';
      const mrBody = (repoPath: string): string => {
        const base = noteFor(repoPath) || summaryArg || bodyFallback;
        if (mrFooter) return `${base}\n\n---\n${mrFooter}`;
        return base || String(res.data.mrDescription ?? '');
      };
      const results: { path: string; mr_url?: string; changed: boolean; error?: string; existed?: boolean }[] = [];
      for (const r of TASK_REPOS) {
        try {
          const changed = await branchHasChanges(r.dir, r.base, { host, token: cred.token });
          if (!changed) {
            results.push({ path: r.path, changed: false });
            continue;
          }
          await pushBranch(r.dir, r.branch, { host, token: cred.token }, () => {});
          const mr = await createMergeRequest({
            host,
            apiBase: cred.baseURL,
            token: cred.token,
            projectPath: r.path,
            sourceBranch: r.branch,
            targetBranch: r.base,
            title: String(res.data.mrTitle ?? r.branch),
            description: mrBody(r.path),
            labels,
          });
          results.push({ path: r.path, mr_url: mr.url, changed: true, existed: mr.existed });
        } catch (err) {
          results.push({ path: r.path, changed: true, error: String(err instanceof Error ? err.message : err) });
        }
      }
      const opened = results.filter((x) => x.mr_url);
      const failed = results.filter((x) => x.error);
      if (opened.length === 0) {
        const why = failed.length
          ? failed.map((f) => `${f.path.split('/').pop()}: ${f.error}`).join('; ')
          : 'no repo has commits beyond its base — commit your work first';
        return toolResult(`push/MR failed: ${why} — fix the cause and call request_mr again`, true);
      }
      const rep = await callBackend('POST', '/api/v1/agent/run/coding-task/report', {
        state: 'mr_created',
        repos: results.filter((x) => x.mr_url).map((x) => ({ path: x.path, mr_url: x.mr_url, changed: true })),
        note:
          `🔀 Merge request${opened.length === 1 ? '' : 's'} ${opened.every((x) => x.existed) ? 'already open' : 'created'}: ` +
          opened.map((x) => `${x.path.split('/').pop()} → ${x.mr_url}`).join(' · ') +
          (failed.length ? ` — ⚠️ failed for ${failed.map((f) => f.path.split('/').pop()).join(', ')}` : ''),
      });
      stopDevServer(WORK_DIR, () => {});
      const summaryText = opened.map((x) => `${x.path}: ${x.mr_url}`).join('; ');
      if (!rep.ok) {
        return toolResult(`merge request(s) opened (${summaryText}), but recording them failed: ${describeFailure(rep.status, rep.data)}. Post the links in the thread.`);
      }
      return toolResult(
        `merge request${opened.length === 1 ? '' : 's'} ${opened.every((x) => x.existed) ? 'found' : 'created'}: ${summaryText}` +
          (failed.length ? ` — FAILED for ${failed.map((f) => `${f.path}: ${f.error}`).join('; ')} (fix and call request_mr again for those)` : '') +
          ' — the task is now mr_created and the thread has been told. Post a one-line wrap-up (what changed, the MR links) and end your turn.',
      );
    }
    case 'task_state': {
      if (!TASK_ID) return toolResult('task_state only works inside a coding task run', true);
      const state = typeof args.state === 'string' ? args.state : '';
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (!state && !note) return toolResult('task_state requires state and/or note', true);
      const res = await callBackend('POST', '/api/v1/agent/run/coding-task/report', { state, note });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(String(res.data.text ?? 'recorded'));
    }
    case 'register_project_commands': {
      if (!TASK_ID || !TASK_PROJECT) return toolResult('register_project_commands only works inside a coding task run', true);
      const str = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
      const repo = taskRepoFor(str('repo') ?? '') ?? (TASK_REPOS.length === 1 ? TASK_REPOS[0] : undefined);
      if (!repo) {
        return toolResult(`register_project_commands needs repo — one of: ${TASK_REPOS.map((r) => r.path).join(', ') || '(none known)'}`, true);
      }
      try {
        const next = updateProjectCommands(workspaceRoot(), repo.path, {
          setupCmd: str('setup_cmd'),
          testCmd: str('test_cmd'),
          devCmd: str('dev_cmd'),
          port: typeof args.port === 'number' ? args.port : undefined,
          notes: str('notes'),
        });
        return toolResult(`registry updated for ${repo.path}: ${JSON.stringify({ setup: next.setupCmd, test: next.testCmd, dev: next.devCmd, port: next.port })}`);
      } catch (err) {
        return toolResult(`registry update failed: ${String(err)}`, true);
      }
    }
    case 'update_memory': {
      const content = typeof args.content === 'string' ? args.content : '';
      const res = await callBackend('POST', '/api/v1/agent/run/memory', { content });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult(`memory updated (${String(res.data.bytes)} bytes)`);
    }
    case 'set_state': {
      const state = typeof args.state === 'string' ? args.state : '';
      const res = await callBackend('POST', '/api/v1/agent/run/state', { state });
      if (!res.ok) return toolResult(describeFailure(res.status, res.data), true);
      return toolResult('state updated');
    }
    default:
      return toolResult(`unknown tool: ${name}`, true);
  }
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;
  switch (req.method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ex', version: '1.0.0' },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications carry no reply
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: visibleTools() });
      return;
    case 'tools/call': {
      const params = req.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        reply(id, applySpill(name, await handleToolCall(name, args)));
      } catch (err) {
        reply(id, toolResult(`tool transport error: ${String(err)} [retryable=true]`, true));
      }
      return;
    }
    default:
      if (req.id !== undefined) replyError(id, -32601, `method not found: ${req.method}`);
  }
}

function main(): void {
  if (!BASE_URL || !RUN_TOKEN) {
    process.stderr.write('ex-mcp: EX_BASE_URL and EX_RUN_TOKEN are required\n');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return; // not JSON-RPC; ignore
    }
    void handle(req);
  });
  // The CLI closing stdin is the shutdown signal; the run token dies with us.
  rl.on('close', () => process.exit(0));
}

main();
