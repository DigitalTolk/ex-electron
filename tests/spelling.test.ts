import { describe, expect, it, vi } from 'vitest';
import { spellingMenuItems } from '../src/lib/spelling';

const misspelled = (dictionarySuggestions: string[], over: { isEditable?: boolean; misspelledWord?: string } = {}) => ({
  isEditable: true,
  misspelledWord: 'wating',
  dictionarySuggestions,
  ...over,
});

describe('spellingMenuItems', () => {
  it('offers up to five suggestions that replace the word, then Learn Spelling on macOS', () => {
    const actions = { replace: vi.fn(), learn: vi.fn() };
    const items = spellingMenuItems(misspelled(['eating', 'waiting', 'wanting', 'rating', 'waging', 'wading']), actions, 'darwin');
    expect(items.map((i) => i.label ?? i.type)).toEqual(['eating', 'waiting', 'wanting', 'rating', 'waging', 'separator', 'Learn Spelling']);
    items[1].click?.({} as never, undefined, {} as never);
    expect(actions.replace).toHaveBeenCalledWith('waiting');
    items[6].click?.({} as never, undefined, {} as never);
    expect(actions.learn).toHaveBeenCalledWith('wating');
  });

  it('says so when there are no suggestions, and uses the Windows/Linux wording there', () => {
    const items = spellingMenuItems(misspelled([]), { replace: vi.fn(), learn: vi.fn() }, 'win32');
    expect(items[0]).toEqual({ label: 'No Guesses Found', enabled: false });
    expect(items[2].label).toBe('Add to Dictionary');
  });

  it('adds nothing for a correctly spelled word or outside a text field', () => {
    const actions = { replace: vi.fn(), learn: vi.fn() };
    expect(spellingMenuItems(misspelled([], { misspelledWord: '' }), actions)).toEqual([]);
    expect(spellingMenuItems(misspelled(['waiting'], { isEditable: false }), actions)).toEqual([]);
  });
});
