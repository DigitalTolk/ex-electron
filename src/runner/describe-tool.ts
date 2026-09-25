// describeToolUse renders a harness permission request as one human-readable
// line for the chat notice + approval card. Raw JSON.stringify of the tool
// input was unreadable in chat (escaped quotes, embedded \n, 300-char blobs)
// — the invoker needs the gist, not the wire format. Separate module so it's
// testable: importing mcp-server.ts runs its stdio main().
// shortenPaths collapses long absolute run-scratch paths so the interesting
// part of a command (the grep pattern, the file name) survives clipping:
// "/Users/…/Application Support/…/threads/<id>/connectors/x" → "…/connectors/x".
function shortenPaths(s: string): string {
  // Path segments may contain spaces ("Application Support") — match lazily
  // up to the anchor directory instead of stopping at whitespace.
  return s.replace(/\/[^'"`]*?\/(connectors|agent-runner)\//g, '…/$1/');
}

export function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const inline = (s: string, n = 160): string => clip(shortenPaths(s.replace(/\s+/g, ' ').trim()), n);
  const size = (s: string): string =>
    s.length >= 1024 ? `${(s.length / 1024).toFixed(1)}KB` : `${s.length}B`;
  switch (toolName) {
    case 'Bash': {
      const desc = inline(str('description'), 120);
      const cmd = inline(str('command'), 220);
      return desc ? `run \`${cmd}\` — ${desc}` : `run \`${cmd}\``;
    }
    case 'Write':
      return `write \`${str('file_path')}\` (${size(str('content'))})`;
    case 'Edit':
    case 'MultiEdit':
      return `edit \`${str('file_path')}\``;
    case 'NotebookEdit':
      return `edit notebook \`${str('notebook_path')}\``;
    case 'Read':
      return `read \`${shortenPaths(str('file_path'))}\``;
    case 'Glob':
    case 'Grep':
      return `search files for \`${inline(str('pattern'), 120)}\``;
    case 'WebFetch':
      return `fetch ${inline(str('url'), 200)}`;
    case 'WebSearch':
      return `search the web for “${inline(str('query'), 120)}”`;
    // Connector tools — say WHICH API is being called, not just "a tool ran".
    case 'mcp__ex__connector_call':
    case 'connector_call': {
      const method = (str('method') || 'GET').toUpperCase();
      let q = '';
      if (input.query && typeof input.query === 'object') {
        q = Object.entries(input.query as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join('&');
        if (q) q = `?${q}`;
      }
      return `${str('connector')} API: ${method} ${str('path')}${inline(q, 80)}`;
    }
    case 'mcp__ex__use_connector':
    case 'use_connector':
      return `attach connector ${str('connector')} — ${inline(str('reason'), 140)}`;
    case 'mcp__ex__connector_lookup':
    case 'connector_lookup': {
      const what = str('route_id') ? `contract ${str('route_id')}` : `“${inline(str('query'), 100)}”`;
      const scope = str('service') ? ` in ${str('service')}` : '';
      return `${str('connector')} docs: look up ${what}${scope}`;
    }
    case 'mcp__ex__fetch_spill':
    case 'fetch_spill':
      return `read more of spilled result ${str('locator')}`;
    case 'mcp__ex__invoke_skill':
    case 'invoke_skill':
      return `use skill ${str('id') || str('skill_id')}`;
    // Coding-task tools.
    case 'mcp__ex__create_coding_task':
    case 'create_coding_task':
      return `open coding task in ${str('project')}: ${inline(str('title'), 100)}`;
    case 'mcp__ex__publish_test_plan':
    case 'publish_test_plan': {
      const steps = Array.isArray(input.steps) ? input.steps.length : 0;
      return `publish test plan — ${str('url') || 'no UI URL'}, ${steps} step${steps === 1 ? '' : 's'}`;
    }
    case 'mcp__ex__request_mr':
    case 'request_mr':
      return 'request the merge request (push + MR after sign-off)';
    case 'mcp__ex__task_state':
    case 'task_state':
      return `task ${str('state') || 'note'}: ${inline(str('note'), 120)}`;
    case 'mcp__ex__register_project_commands':
    case 'register_project_commands':
      return 'remember project commands in the workspace registry';
    default: {
      let detail: string;
      try {
        detail = JSON.stringify(input);
      } catch {
        detail = '(unserializable input)';
      }
      return `use ${toolName} \`${inline(detail, 200)}\``;
    }
  }
}
