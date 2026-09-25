// Log-derived prompts for the Bedrock loop — the "model-visible means logged"
// invariant, adapted from DeepSeek Harness's session-log design.
//
// The loop never mutates a messages array. It appends typed events to an
// APPEND-ONLY session log, and every Converse request derives its messages
// fresh from that log via deriveMessages(). Consequences, by construction:
//   - nothing can reach the model that isn't in the log (no drift between
//     what we recorded and what the model saw);
//   - a run's exact model-visible history is replayable from its log alone
//     (fork/debug/audit fall out for free);
//   - new model-visible inputs REQUIRE a new SessionEvent variant — there is
//     no side door.
import type { ContentBlock, Message } from '@aws-sdk/client-bedrock-runtime';

// SessionEvent is the closed set of things a Bedrock run may show the model.
// Extend this union to add a new model-visible input — that is the point.
export type SessionEvent =
  // A user-authored turn (the task prompt + context bundle, or a resume nudge).
  | { kind: 'user'; text: string }
  // The assistant's turn, kept VERBATIM (raw Converse message) so replay
  // reproduces exactly what the model said — including toolUse blocks.
  | { kind: 'assistant'; message: Message }
  // One tool's result. Consecutive tool_result events collapse into a single
  // user turn on derivation (the Converse API requires every toolResult for
  // an assistant turn in one user message).
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean };

// deriveMessages reconstructs the Converse message history from the log.
// Pure and total: same log in, same messages out — this IS the model's view.
export function deriveMessages(log: readonly SessionEvent[]): Message[] {
  const out: Message[] = [];
  let pendingResults: ContentBlock[] = [];

  const flushResults = () => {
    if (pendingResults.length === 0) return;
    out.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };

  for (const ev of log) {
    switch (ev.kind) {
      case 'user':
        flushResults();
        out.push({ role: 'user', content: [{ text: ev.text }] });
        break;
      case 'assistant':
        flushResults();
        out.push(ev.message);
        break;
      case 'tool_result':
        pendingResults.push({
          toolResult: {
            toolUseId: ev.toolUseId,
            content: [{ text: ev.text }],
            status: ev.isError ? 'error' : 'success',
          },
        });
        break;
    }
  }
  flushResults();
  return out;
}
