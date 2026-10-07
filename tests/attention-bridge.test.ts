import { describe, expect, it } from 'vitest';

import {
  ATTENTION_BRIDGE_SOURCE,
  ATTENTION_REQUEST_EVENT,
  installAttentionAnswerer,
} from '../src/lib/attention-bridge';

// Minimal fake for the shared DOM the bridge crosses (same pattern as the
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
