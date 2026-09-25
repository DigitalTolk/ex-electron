import { describe, expect, it } from 'vitest';

import {
  ATTENTION_BRIDGE_SOURCE,
  ATTENTION_REQUEST_EVENT,
  installAttentionAnswerer,
} from '../src/lib/attention-bridge';
import {
  RUNNER_BRIDGE_SOURCE,
  RUNNER_TOKEN_ATTR,
  RUNNER_TOKEN_EVENT,
  installRunnerTokenListener,
} from '../src/lib/runner-bridge';

// Minimal fake for the shared DOM the bridges cross (same pattern as the
// approval/DnD bridge tests).
function makeFakeDoc() {
  const listeners = new Map<string, Set<() => void>>();
  const attrs = new Map<string, string>();
  const doc = {
    addEventListener(type: string, handler: () => void) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(handler);
    },
    dispatchEvent(event: { type: string }) {
      for (const handler of [...(listeners.get(event.type) ?? [])]) handler();
      return true;
    },
    documentElement: {
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
      getAttribute: (name: string) => attrs.get(name) ?? null,
      removeAttribute: (name: string) => void attrs.delete(name),
    },
  };
  return { doc: doc as unknown as Document, raw: doc, attrs };
}

describe('runner token bridge (preload half)', () => {
  it('reads the stamped token, scrubs it from the DOM, forwards it to main', () => {
    const { doc, raw, attrs } = makeFakeDoc();
    const sent: string[] = [];
    installRunnerTokenListener(doc, (t) => sent.push(t));

    attrs.set(RUNNER_TOKEN_ATTR, 'tok-abc');
    raw.dispatchEvent({ type: RUNNER_TOKEN_EVENT });

    expect(sent).toEqual(['tok-abc']);
    // The token never lingers in the DOM.
    expect(attrs.has(RUNNER_TOKEN_ATTR)).toBe(false);
  });

  it('ignores a token event with nothing stamped', () => {
    const { doc, raw } = makeFakeDoc();
    const sent: string[] = [];
    installRunnerTokenListener(doc, (t) => sent.push(t));
    raw.dispatchEvent({ type: RUNNER_TOKEN_EVENT });
    expect(sent).toEqual([]);
  });

  it('page-side source stamps the attribute and validates the token shape', () => {
    // The injected source references the same attr/event names the listener
    // reads — a rename on one side must fail this.
    expect(RUNNER_BRIDGE_SOURCE).toContain(RUNNER_TOKEN_ATTR);
    expect(RUNNER_BRIDGE_SOURCE).toContain(RUNNER_TOKEN_EVENT);
    expect(RUNNER_BRIDGE_SOURCE).toContain('length > 4096');
  });
});

describe('attention bridge (preload half)', () => {
  it('forwards each page request to main', () => {
    const { doc, raw } = makeFakeDoc();
    let asked = 0;
    installAttentionAnswerer(doc, () => {
      asked += 1;
    });
    raw.dispatchEvent({ type: ATTENTION_REQUEST_EVENT });
    raw.dispatchEvent({ type: ATTENTION_REQUEST_EVENT });
    expect(asked).toBe(2);
  });

  it('page-side source dispatches the request event', () => {
    expect(ATTENTION_BRIDGE_SOURCE).toContain(ATTENTION_REQUEST_EVENT);
  });
});
