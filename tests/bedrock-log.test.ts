import { describe, expect, it } from 'vitest';
import type { Message } from '@aws-sdk/client-bedrock-runtime';

import { deriveMessages, type SessionEvent } from '../src/runner/harness/bedrock-log';

const assistant = (content: Message['content']): Message => ({ role: 'assistant', content });

describe('deriveMessages (log-derived prompts)', () => {
  it('derives the opening user turn', () => {
    const log: SessionEvent[] = [{ kind: 'user', text: 'task + bundle' }];
    expect(deriveMessages(log)).toEqual([{ role: 'user', content: [{ text: 'task + bundle' }] }]);
  });

  it('keeps assistant turns verbatim (toolUse blocks included)', () => {
    const msg = assistant([
      { text: 'let me check' },
      { toolUse: { toolUseId: 'tu-1', name: 'get_thread', input: {} } },
    ]);
    const log: SessionEvent[] = [
      { kind: 'user', text: 't' },
      { kind: 'assistant', message: msg },
    ];
    expect(deriveMessages(log)[1]).toBe(msg); // exact object — replay-faithful
  });

  it('folds consecutive tool results into ONE user turn, as Converse requires', () => {
    const log: SessionEvent[] = [
      { kind: 'user', text: 't' },
      { kind: 'assistant', message: assistant([{ toolUse: { toolUseId: 'tu-1', name: 'a', input: {} } }]) },
      { kind: 'tool_result', toolUseId: 'tu-1', text: 'r1', isError: false },
      { kind: 'tool_result', toolUseId: 'tu-2', text: 'r2', isError: true },
    ];
    const out = deriveMessages(log);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { toolResult: { toolUseId: 'tu-1', content: [{ text: 'r1' }], status: 'success' } },
        { toolResult: { toolUseId: 'tu-2', content: [{ text: 'r2' }], status: 'error' } },
      ],
    });
  });

  it('reconstructs a full multi-round conversation deterministically', () => {
    const a1 = assistant([{ toolUse: { toolUseId: 'tu-1', name: 'search', input: { q: 'x' } } }]);
    const a2 = assistant([{ toolUse: { toolUseId: 'tu-2', name: 'get_thread', input: {} } }]);
    const a3 = assistant([{ text: 'final answer' }]);
    const log: SessionEvent[] = [
      { kind: 'user', text: 'task' },
      { kind: 'assistant', message: a1 },
      { kind: 'tool_result', toolUseId: 'tu-1', text: 'hits', isError: false },
      { kind: 'assistant', message: a2 },
      { kind: 'tool_result', toolUseId: 'tu-2', text: 'thread', isError: false },
      { kind: 'assistant', message: a3 },
    ];
    const out = deriveMessages(log);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    // Same log in → same messages out: the log alone determines the model's view.
    expect(deriveMessages(log)).toEqual(out);
  });

  it('mirrors the loop exactly: deriving after each append equals the old imperative build', () => {
    // Simulate what runBedrock does per iteration and assert the derived
    // history at each request boundary matches the hand-built equivalent.
    const log: SessionEvent[] = [{ kind: 'user', text: 'go' }];
    expect(deriveMessages(log)).toEqual([{ role: 'user', content: [{ text: 'go' }] }]);

    const turn1 = assistant([{ toolUse: { toolUseId: 'tu-1', name: 'post_message', input: { body: 'hi' } } }]);
    log.push({ kind: 'assistant', message: turn1 });
    log.push({ kind: 'tool_result', toolUseId: 'tu-1', text: 'posted', isError: false });
    expect(deriveMessages(log)).toEqual([
      { role: 'user', content: [{ text: 'go' }] },
      turn1,
      { role: 'user', content: [{ toolResult: { toolUseId: 'tu-1', content: [{ text: 'posted' }], status: 'success' } }] },
    ]);
  });
});
