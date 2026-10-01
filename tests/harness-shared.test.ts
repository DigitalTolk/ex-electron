import { describe, expect, it } from 'vitest';

import { claudeToolArgs, flattenToolResult, LEAN_CLAUDE_TOOLS, runHasConnectors, systemRules } from '../src/runner/harness/shared';

describe('flattenToolResult', () => {
  it('renders a string result with its size', () => {
    expect(flattenToolResult('hello  world')).toBe('hello world (11B)');
  });

  it('joins content blocks, tolerating entries without text', () => {
    expect(flattenToolResult([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a b (3B)');
  });

  it('returns empty for missing or whitespace-only content', () => {
    expect(flattenToolResult(undefined)).toBe('');
    expect(flattenToolResult('   \n  ')).toBe('');
  });

  it('clips long results and reports KB sizes', () => {
    const out = flattenToolResult('x'.repeat(2048));
    expect(out).toBe(`${'x'.repeat(220)}… (2.0KB)`);
  });
});

describe('runHasConnectors', () => {
  it('is true for /picks, installed-connector bundles, and connected services', () => {
    expect(runHasConnectors({ connectorSlugs: ['hub'], contextBundle: '' })).toBe(true);
    expect(runHasConnectors({ connectorSlugs: [], contextBundle: 'x\n# Installed connectors\n- hub' })).toBe(true);
    expect(runHasConnectors({ connectorSlugs: undefined, contextBundle: 'note: [connected services] here' })).toBe(true);
  });

  it('is false when the run has nothing to connect to', () => {
    expect(runHasConnectors({ connectorSlugs: [], contextBundle: 'plain thread' })).toBe(false);
  });
});

describe('systemRules', () => {
  it('layers the persona and names into the contract', () => {
    const rules = systemRules('gg', 'Alice', 'You are helpful.', { connectors: false });
    expect(rules.startsWith('You are helpful.')).toBe(true);
    expect(rules).toContain('You are "gg"');
    expect(rules).toContain('invoked by Alice');
    expect(rules).not.toContain('connector_call is the ONLY way');
  });

  it('adds the connector workflow only when the run can reach a service', () => {
    expect(systemRules('gg', 'Alice', 'p', { connectors: true })).toContain('connector_call is the ONLY way');
    // opts omitted entirely → the default-parameter branch, no connector rules.
    expect(systemRules('gg', 'Alice', 'p')).not.toContain('connector_call is the ONLY way');
  });
});

describe('claudeToolArgs', () => {
  it('trims a chat run to the lean toolset, keeping ToolSearch and a shell for every OS', () => {
    const args = claudeToolArgs({}, {});
    expect(args).toEqual(['--tools', LEAN_CLAUDE_TOOLS.join(','), '--disable-slash-commands']);
    // Without ToolSearch every Ex MCP tool would load up front.
    for (const needed of ['ToolSearch', 'Bash', 'PowerShell', 'Read']) expect(LEAN_CLAUDE_TOOLS).toContain(needed);
  });

  it('leaves coding tasks and explicit full-tool runs on the full set', () => {
    expect(claudeToolArgs({ task: { id: 't' } as never }, {})).toEqual([]);
    expect(claudeToolArgs({}, { EX_RUNNER_FULL_TOOLS: '1' })).toEqual([]);
  });
});
