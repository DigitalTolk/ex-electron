import { describe, expect, it } from 'vitest';

import {
  CORE_TOOLS,
  indexedTools,
  signature,
  summary,
  TOOL_CALL,
  TOOL_INFO,
  toolInfo,
  unwrapCall,
  type ToolDef,
} from '../src/runner/tool-index';

const def = (name: string, description: string, required: string[] = []): ToolDef => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } }, required },
});

const visible = [
  def('post_message', 'Post into the thread. Long details follow.'),
  def('get_thread', 'Read the thread.'),
  def('list_channels', 'List the channels your invoker is in. They can read them.'),
  def('set_reminder', 'Set a reminder for YOUR INVOKER — it fires later', ['x']),
];

describe('summary', () => {
  it('keeps the first sentence and caps long ones', () => {
    expect(summary('Read  the\nthread. Then more.')).toBe('Read the thread.');
    expect(summary('No full stop here')).toBe('No full stop here');
    expect(summary('v1.2 stays whole. Next.')).toBe('v1.2 stays whole.');
    const long = summary('x'.repeat(200));
    expect(long).toHaveLength(108);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('signature', () => {
  it('lists arguments, marking optional ones', () => {
    expect(signature(visible[3])).toBe('set_reminder(x, y?)');
    expect(signature({ name: 'bare', description: '', inputSchema: {} })).toBe('bare()');
  });
});

describe('indexedTools', () => {
  it('advertises core tools in full and catalogues the rest in ex_tool_info', () => {
    const tools = indexedTools(visible);
    expect(tools.map((t) => t.name)).toEqual(['post_message', 'get_thread', TOOL_INFO, TOOL_CALL]);
    expect(tools[0]).toBe(visible[0]);
    const info = tools.find((t) => t.name === TOOL_INFO)!;
    expect(info.description).toContain("before telling anyone you can't do something");
    expect(info.description).toContain('- list_channels(x?, y?): List the channels your invoker is in.');
    expect(info.description).toContain('- set_reminder(x, y?): Set a reminder for YOUR INVOKER — it fires later');
    expect(info.description).not.toContain('They can read them');
    expect(tools.find((t) => t.name === TOOL_CALL)!.description).toContain('AFTER reading its contract');
  });

  it('adds no meta-tools when every visible tool is core', () => {
    const coreOnly = visible.filter((t) => CORE_TOOLS.has(t.name));
    expect(indexedTools(coreOnly)).toEqual(coreOnly);
  });
});

describe('toolInfo', () => {
  it('returns full contracts, records them as read, and says which names are unavailable', () => {
    const described = new Set<string>();
    const out = toolInfo(visible, ['list_channels', 'nope', 7], described);
    expect(out).toContain('## list_channels\nList the channels your invoker is in. They can read them.');
    expect(out).toContain('Arguments (JSON schema): {"type":"object"');
    expect(out).toContain('## nope\n(no such tool available to this run)');
    expect([...described]).toEqual(['list_channels']);
  });

  it('requires names', () => {
    expect(toolInfo(visible, [])).toBe('ex_tool_info requires names');
    expect(toolInfo(visible, 'list_channels')).toBe('ex_tool_info requires names');
  });
});

describe('unwrapCall', () => {
  it('hands the contract back instead of running a tool whose contract was not read', () => {
    const described = new Set<string>();
    const first = unwrapCall(visible, { tool: 'set_reminder', arguments: {} }, described);
    expect('contract' in first && first.contract).toContain("Not run: read set_reminder's contract first");
    expect('contract' in first && first.contract).toContain('## set_reminder');
    // …which counts as reading it: the next call runs.
    expect(unwrapCall(visible, { tool: 'set_reminder', arguments: { x: 'a' } }, described)).toEqual({
      name: 'set_reminder',
      args: { x: 'a' },
    });
    // `name` works as well as `tool`.
    expect(unwrapCall(visible, { name: 'set_reminder', arguments: { x: 'b' } }, described)).toEqual({
      name: 'set_reminder',
      args: { x: 'b' },
    });
  });

  it('refuses a call missing required arguments, with the contract', () => {
    const described = new Set(['set_reminder']);
    const out = unwrapCall(visible, { tool: 'set_reminder', arguments: { y: 1 } }, described);
    expect('contract' in out && out.contract).toContain('Not run: missing required arguments x.');
  });

  it('runs a read tool, normalising absent or malformed arguments', () => {
    const described = new Set(['list_channels']);
    expect(unwrapCall(visible, { tool: 'list_channels' }, described)).toEqual({ name: 'list_channels', args: {} });
    expect(unwrapCall(visible, { tool: 'list_channels', arguments: ['bad'] }, described)).toEqual({ name: 'list_channels', args: {} });
    // A schema with no required list at all.
    const bare: ToolDef = { name: 'bare', description: 'Bare.', inputSchema: {} };
    expect(unwrapCall([bare], { tool: 'bare' }, new Set(['bare']))).toEqual({ name: 'bare', args: {} });
  });

  it('refuses a missing name, meta-tools and anything the run may not use', () => {
    const described = new Set<string>();
    expect(unwrapCall(visible, {}, described)).toEqual({ error: 'ex_tool_call requires tool' });
    for (const name of [TOOL_CALL, TOOL_INFO, 'send_dm']) {
      expect(unwrapCall(visible, { tool: name }, described)).toEqual({ error: `no such tool available to this run: ${name}` });
    }
  });
});
