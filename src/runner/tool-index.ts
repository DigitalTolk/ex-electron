// Tool index: a light tool list for harnesses that load every MCP tool
// definition up front (codex). Claude Code already defers MCP tools behind
// ToolSearch; codex re-sends all 43 Ex definitions (~6.6k tokens) on every
// call although runs use a handful. The index advertises the tools runs
// actually use in full, and reaches the rest through two meta-tools: one
// returns a tool's full contract, the other calls it.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// CORE_TOOLS stay fully advertised: together they were ~90% of the Ex tool
// calls across 77 recorded runs (2026-09-30), and the connector trio drives
// the flow agents are most often asked for.
export const CORE_TOOLS = new Set([
  'post_message',
  'get_thread',
  'get_context',
  'set_state',
  'connector_lookup',
  'connector_call',
  'use_connector',
  'fetch_spill',
  'request_approval',
]);

export const TOOL_INFO = 'ex_tool_info';
export const TOOL_CALL = 'ex_tool_call';

// summary is a tool's first sentence, capped — enough to pick it by, not to
// call it with.
export function summary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end >= 0 ? flat.slice(0, end + 1) : flat;
  return first.length > 110 ? `${first.slice(0, 107)}…` : first;
}

// signature renders a tool's arguments compactly — "set_reminder(in_minutes?,
// remind_at?)" — so the catalog says what a tool takes without its schema.
export function signature(t: ToolDef): string {
  const props = Object.keys((t.inputSchema.properties as Record<string, unknown> | undefined) ?? {});
  const required = new Set((t.inputSchema.required as string[] | undefined) ?? []);
  return `${t.name}(${props.map((p) => (required.has(p) ? p : `${p}?`)).join(', ')})`;
}

// indexedTools is the advertised set in index mode: core tools in full plus
// the two meta-tools. The catalog rides ex_tool_info — the entry point an
// agent looks at when the tools above don't cover the task; buried in the
// call tool's description, codex skimmed past it and told people it
// "can't access your channel list".
export function indexedTools(visible: ToolDef[]): ToolDef[] {
  const core = visible.filter((t) => CORE_TOOLS.has(t.name));
  const rest = visible.filter((t) => !CORE_TOOLS.has(t.name));
  if (rest.length === 0) return core;
  const catalog = rest.map((t) => `- ${signature(t)}: ${summary(t.description)}`).join('\n');
  return [
    ...core,
    {
      name: TOOL_INFO,
      description:
        'MORE EX TOOLS — channels, DMs, people, reminders, reactions, pins, scheduled orders, search, ' +
        "skills and more are listed below. Check this list before telling anyone you can't do something. " +
        'Pass the names you need to get each one\'s full contract (when to use it, exact arguments), then run ' +
        `it with ex_tool_call.\n${catalog}`,
      inputSchema: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names from the list.' } },
        required: ['names'],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_CALL,
      description:
        'Run a tool from the ex_tool_info list, AFTER reading its contract with ex_tool_info. A tool whose ' +
        'contract you have not read, or a call missing required arguments, is not run — you get the contract back.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Tool name from the ex_tool_info list.' },
          arguments: { type: 'object', description: "The tool's arguments, per its contract." },
        },
        required: ['tool'],
        additionalProperties: false,
      },
    },
  ];
}

// toolInfo renders the full contracts for the requested names and records
// them in `described`, which is what lets ex_tool_call run them.
export function toolInfo(visible: ToolDef[], names: unknown, described?: Set<string>): string {
  const wanted = Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
  if (wanted.length === 0) return 'ex_tool_info requires names';
  return wanted
    .map((name) => {
      const t = visible.find((d) => d.name === name);
      if (!t) return `## ${name}\n(no such tool available to this run)`;
      described?.add(t.name);
      return `## ${t.name}\n${t.description}\nArguments (JSON schema): ${JSON.stringify(t.inputSchema)}`;
    })
    .join('\n\n');
}

// unwrapCall resolves an ex_tool_call into the real tool call. It runs only a
// tool the agent has read the contract of, with its required arguments
// present; otherwise it hands the contract back instead of a failed call —
// guessing arguments ("set_reminder {}") was the commonest waste in index mode.
export function unwrapCall(
  visible: ToolDef[],
  args: Record<string, unknown>,
  described: Set<string>,
): { name: string; args: Record<string, unknown> } | { error: string } | { contract: string } {
  // `name` is accepted too: having just read "## <name>" contracts, codex
  // reached for {"name": …} and burned a call on the error.
  const raw = typeof args.tool === 'string' ? args.tool : args.name;
  const name = typeof raw === 'string' ? raw : '';
  if (!name) return { error: 'ex_tool_call requires tool' };
  const t = visible.find((d) => d.name === name);
  if (!t || name === TOOL_CALL || name === TOOL_INFO) {
    return { error: `no such tool available to this run: ${name}` };
  }
  const inner = args.arguments;
  const callArgs = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
  if (!described.has(name)) {
    return { contract: `Not run: read ${name}'s contract first, then call it again.\n\n${toolInfo(visible, [name], described)}` };
  }
  const missing = ((t.inputSchema.required as string[] | undefined) ?? []).filter((k) => callArgs[k] === undefined);
  if (missing.length > 0) {
    return { contract: `Not run: missing required arguments ${missing.join(', ')}.\n\n${toolInfo(visible, [name])}` };
  }
  return { name, args: callArgs };
}
