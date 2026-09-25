import { describe, expect, it } from 'vitest';

import { mcpResultToText, toConverseToolConfig } from '../src/runner/harness/bedrock-tools';

describe('toConverseToolConfig', () => {
  it('maps MCP tool defs to Converse toolSpec, passing the schema through', () => {
    const cfg = toConverseToolConfig([
      {
        name: 'post_message',
        description: 'Post your reply.',
        inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      },
    ]);
    expect(cfg.tools).toHaveLength(1);
    expect(cfg.tools[0].toolSpec.name).toBe('post_message');
    expect(cfg.tools[0].toolSpec.description).toBe('Post your reply.');
    expect(cfg.tools[0].toolSpec.inputSchema.json).toEqual({
      type: 'object',
      properties: { body: { type: 'string' } },
      required: ['body'],
    });
  });

  it('drops approval_prompt (CLI-only permission gateway — API agents have no native tools)', () => {
    const cfg = toConverseToolConfig([
      { name: 'approval_prompt', description: 'gateway', inputSchema: { type: 'object' } },
      { name: 'get_thread', description: 'read', inputSchema: { type: 'object' } },
    ]);
    expect(cfg.tools.map((t) => t.toolSpec.name)).toEqual(['get_thread']);
  });

  it('substitutes a minimal object schema when a tool has none', () => {
    const cfg = toConverseToolConfig([
      { name: 'x', description: 'd', inputSchema: null as unknown as Record<string, unknown> },
    ]);
    expect(cfg.tools[0].toolSpec.inputSchema.json).toEqual({ type: 'object', properties: {} });
  });
});

describe('mcpResultToText', () => {
  it('flattens text content blocks and reports the error flag', () => {
    expect(mcpResultToText({ content: [{ type: 'text', text: 'posted' }] })).toEqual({
      text: 'posted',
      isError: false,
    });
    expect(mcpResultToText({ content: [{ type: 'text', text: 'nope' }], isError: true })).toEqual({
      text: 'nope',
      isError: true,
    });
  });

  it('falls back to a placeholder when there is no text', () => {
    expect(mcpResultToText({ content: [] }).text).toBe('(no output)');
    expect(mcpResultToText(null).text).toBe('(no output)');
  });
});
