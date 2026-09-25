// The backend writes rejections as {error: {code, message}} (handler
// writeError), but every reader in the MCP server — describeFailure and the
// per-tool 409 branches — keys off flat `error` (the code) and `message`
// fields. This shipped shape-blind once: a project_unknown 409 fell through
// to the "already has an active task" fallback because `data.error` was an
// object and `data.message` was undefined. Separate module so it's testable:
// importing mcp-server.ts runs its stdio main().

// flattenBackendError hoists a nested {error: {code, message}} body in place:
// `error` becomes the code string, `message` the human text. Flat or foreign
// shapes pass through untouched, and an existing flat `message` wins.
export function flattenBackendError(data: Record<string, unknown>): Record<string, unknown> {
  const wrapped = data.error;
  if (wrapped && typeof wrapped === 'object') {
    const { code, message } = wrapped as Record<string, unknown>;
    if (typeof code === 'string') data.error = code;
    if (typeof message === 'string' && typeof data.message !== 'string') data.message = message;
  }
  return data;
}
