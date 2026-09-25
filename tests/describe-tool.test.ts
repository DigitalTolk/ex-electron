import { describe, expect, it } from 'vitest';

import { describeToolUse } from '../src/runner/describe-tool';

describe('describeToolUse', () => {
  it('renders Bash with its description and command, no JSON', () => {
    const out = describeToolUse('Bash', {
      command: 'lsof -nP -iTCP:8072 -sTCP:LISTEN 2>/dev/null || echo "port 8072 free"',
      description: 'List working dir and check port 8072',
    });
    expect(out).toContain('List working dir and check port 8072');
    expect(out).toContain('`lsof -nP');
    expect(out).not.toContain('{"command"');
    expect(out).not.toContain('\\"');
  });

  it('renders Write as path + size, never the content', () => {
    const out = describeToolUse('Write', {
      file_path: '/tmp/site/index.html',
      content: '<html lang="en">\n<meta charset="utf-8">\n'.repeat(40),
    });
    expect(out).toContain('write `/tmp/site/index.html`');
    expect(out).toMatch(/\(\d+(\.\d+)?(B|KB)\)/);
    expect(out).not.toContain('<html');
    expect(out).not.toContain('\\n');
  });

  it('collapses whitespace and clips long commands', () => {
    const out = describeToolUse('Bash', { command: `echo a\n${'x'.repeat(500)}` });
    expect(out).toContain('echo a x'); // newline collapsed
    expect(out).toContain('…');
    // Commands get a 220-char budget (plus the `run \`…\`` framing) so grep
    // patterns and paths survive; still bounded.
    expect(out.length).toBeLessThan(240);
  });

  it('shortens run-scratch paths so patterns survive clipping', () => {
    const out = describeToolUse('Bash', {
      command:
        "grep -i 'leave' '/Users/someone/Library/Application Support/ex-dev/agent-runner/threads/abc123/connectors/cliffhub/_catalog.tsv'",
    });
    expect(out).toContain('…/connectors/cliffhub/_catalog.tsv');
    expect(out).not.toContain('Application Support');
  });

  it('falls back to compact JSON for unknown tools', () => {
    const out = describeToolUse('SomeTool', { alpha: 1, beta: 'two' });
    expect(out).toBe('use SomeTool `{"alpha":1,"beta":"two"}`');
  });

  it('says "(unserializable input)" when the input cannot stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeToolUse('SomeTool', cyclic)).toBe('use SomeTool `(unserializable input)`');
  });

  it('renders every file/search/web tool as its one-line gist', () => {
    expect(describeToolUse('Bash', { command: 'ls' })).toBe('run `ls`'); // no description
    expect(describeToolUse('Edit', { file_path: '/a/b.ts' })).toBe('edit `/a/b.ts`');
    expect(describeToolUse('MultiEdit', { file_path: '/a/b.ts' })).toBe('edit `/a/b.ts`');
    expect(describeToolUse('NotebookEdit', { notebook_path: '/n.ipynb' })).toBe('edit notebook `/n.ipynb`');
    expect(describeToolUse('Read', { file_path: '/x/agent-runner/threads/t/f' })).toBe('read `…/agent-runner/threads/t/f`');
    expect(describeToolUse('Glob', { pattern: '**/*.ts' })).toBe('search files for `**/*.ts`');
    expect(describeToolUse('Grep', { pattern: 'getYear' })).toBe('search files for `getYear`');
    expect(describeToolUse('WebFetch', { url: 'https://ex.example/doc' })).toBe('fetch https://ex.example/doc');
    expect(describeToolUse('WebSearch', { query: 'leap year rules' })).toBe('search the web for “leap year rules”');
  });

  it('renders the mcp__ex__ aliases identically to the bare names', () => {
    expect(describeToolUse('mcp__ex__use_connector', { connector: 'hub', reason: 'r' })).toBe('attach connector hub — r');
    expect(describeToolUse('mcp__ex__fetch_spill', { locator: 'sp-9' })).toBe('read more of spilled result sp-9');
    expect(describeToolUse('mcp__ex__create_coding_task', { project: 'P', title: 't' })).toBe('open coding task in P: t');
    expect(describeToolUse('mcp__ex__request_mr', {})).toBe('request the merge request (push + MR after sign-off)');
    expect(describeToolUse('mcp__ex__register_project_commands', {})).toBe('remember project commands in the workspace registry');
    // Tiny writes report bytes, not KB.
    expect(describeToolUse('Write', { file_path: '/a', content: 'hi' })).toBe('write `/a` (2B)');
  });

  it('names the API being called for connector tools, with the query string', () => {
    expect(
      describeToolUse('mcp__ex__connector_call', {
        connector: 'hub',
        method: 'post',
        path: 'api/people',
        query: { per_page: 5, q: 'x' },
      }),
    ).toBe('hub API: POST api/people?per_page=5&q=x');
    // GET default, object-less query, and the bare (non-mcp) alias.
    expect(describeToolUse('connector_call', { connector: 'hub', path: 'api/people', query: {} })).toBe('hub API: GET api/people');
    expect(describeToolUse('connector_call', { connector: 'hub', path: 'api/people', query: 'nope' })).toBe('hub API: GET api/people');
    expect(describeToolUse('connector_call', { connector: 'hub', path: 'api/people' })).toBe('hub API: GET api/people');
  });

  it('renders the connector doc/attach/spill/skill tools', () => {
    expect(describeToolUse('use_connector', { connector: 'hub', reason: 'people data' })).toBe('attach connector hub — people data');
    expect(describeToolUse('mcp__ex__connector_lookup', { connector: 'hub', route_id: 'people.list' })).toBe('hub docs: look up contract people.list');
    expect(describeToolUse('connector_lookup', { connector: 'hub', query: 'leads', service: 'crm' })).toBe('hub docs: look up “leads” in crm');
    expect(describeToolUse('fetch_spill', { locator: 'sp-2' })).toBe('read more of spilled result sp-2');
    expect(describeToolUse('invoke_skill', { skill_id: 'sk-1' })).toBe('use skill sk-1');
    expect(describeToolUse('mcp__ex__invoke_skill', { id: 'sk-2' })).toBe('use skill sk-2');
  });

  it('renders the coding-task tools', () => {
    expect(describeToolUse('create_coding_task', { project: 'CliffHub', title: 'fix login' })).toBe('open coding task in CliffHub: fix login');
    expect(describeToolUse('publish_test_plan', { url: 'http://localhost:5273', steps: [1, 2] })).toBe('publish test plan — http://localhost:5273, 2 steps');
    expect(describeToolUse('mcp__ex__publish_test_plan', { steps: [1] })).toBe('publish test plan — no UI URL, 1 step');
    expect(describeToolUse('publish_test_plan', {})).toBe('publish test plan — no UI URL, 0 steps');
    expect(describeToolUse('request_mr', {})).toBe('request the merge request (push + MR after sign-off)');
    expect(describeToolUse('task_state', { state: 'blocked', note: 'waiting on API' })).toBe('task blocked: waiting on API');
    expect(describeToolUse('mcp__ex__task_state', {})).toBe('task note: ');
    expect(describeToolUse('register_project_commands', {})).toBe('remember project commands in the workspace registry');
  });
});
