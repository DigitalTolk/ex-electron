// Pure helpers for the Bedrock API harness: translate the ex MCP tool
// schemas into Bedrock Converse toolConfig, and a minimal MCP stdio client
// so the loop reuses the EXACT same tool surface the CLI harnesses drive
// (post_message, get_thread, approvals, workspace tools…) with zero changes
// to the working MCP server. Kept dependency-free and side-effect-free so it
// is unit-testable without spawning anything.

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Bedrock Converse toolConfig shape (the subset we emit).
export interface ConverseToolConfig {
  tools: { toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }[];
}

// approval_prompt is the CLI permission gateway for native tools; an API
// agent has no local shell/files, so it is never offered.
const API_TOOL_DENYLIST = new Set(['approval_prompt']);

// toConverseToolConfig maps MCP tool defs → Bedrock Converse tools. Converse
// requires a non-empty JSON-Schema object per tool; we pass the MCP
// inputSchema straight through (both are JSON Schema draft-07 objects).
export function toConverseToolConfig(tools: McpTool[]): ConverseToolConfig {
  return {
    tools: tools
      .filter((t) => !API_TOOL_DENYLIST.has(t.name))
      .map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: {
            json:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} },
          },
        },
      })),
  };
}

// mcpResultToText flattens an MCP tools/call result ({content:[{type:'text',
// text}]}) into the plain string a Converse toolResult block carries.
export function mcpResultToText(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean } | null;
  const text = (r?.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
  return { text: text || '(no output)', isError: r?.isError === true };
}
