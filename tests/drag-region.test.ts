import { describe, expect, it } from 'vitest';
import { CHAT_DRAG_REGION_CSS } from '../src/lib/drag-region';

// Parses the CSS string into [selector, declarations] tuples, so the tests
// can assert behaviour declaratively instead of grepping substrings.
function parseRules(css: string): Array<{ selectors: string[]; props: Record<string, string> }> {
  const rules: Array<{ selectors: string[]; props: Record<string, string> }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const selectors = match[1].split(',').map((s) => s.trim()).filter(Boolean);
    const props: Record<string, string> = {};
    for (const decl of match[2].split(';')) {
      const [k, v] = decl.split(':');
      if (!k || v === undefined) continue;
      props[k.trim()] = v.trim();
    }
    rules.push({ selectors, props });
  }
  return rules;
}

function appRegionFor(selector: string): string | undefined {
  const rules = parseRules(CHAT_DRAG_REGION_CSS);
  const rule = rules.find((r) => r.selectors.includes(selector));
  return rule?.props['-webkit-app-region'];
}

describe('chat drag region css', () => {
  it('marks the app-chrome title bar as a window drag region', () => {
    expect(appRegionFor('[data-app-chrome="true"]')).toBe('drag');
  });

  it('does NOT mark plain <header> elements as a drag region', () => {
    // A blanket `header { -webkit-app-region: drag }` rule swallows wheel
    // events over every <header> the SPA renders (thread cards, channel
    // headers, the thread panel), leaving the page stuck when the cursor
    // sits over them. Only the real title bar should drag.
    expect(appRegionFor('header')).toBeUndefined();
  });

  it('opts common interactive controls out of the drag region', () => {
    for (const selector of ['input', 'textarea', 'select', 'button', 'a']) {
      expect(appRegionFor(selector)).toBe('no-drag');
    }
  });

  it('opts ARIA-role interactive controls out of the drag region', () => {
    for (const role of ['button', 'link', 'textbox', 'searchbox', 'combobox', 'menuitem', 'tab']) {
      expect(appRegionFor(`[role="${role}"]`)).toBe('no-drag');
    }
  });

  it('opts contenteditable elements out of the drag region', () => {
    for (const selector of [
      '[contenteditable="true"]',
      '[contenteditable=""]',
      '[contenteditable="plaintext-only"]',
    ]) {
      expect(appRegionFor(selector)).toBe('no-drag');
    }
  });

  it('only sets app-region — does not introduce stray sizing or positioning', () => {
    const rules = parseRules(CHAT_DRAG_REGION_CSS);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(Object.keys(rule.props)).toEqual(['-webkit-app-region']);
    }
  });
});
