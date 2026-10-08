import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

export interface SpellingActions {
  // Swap the misspelled word under the cursor for a suggestion.
  replace: (suggestion: string) => void;
  // Stop flagging this word (adds it to the spellchecker's dictionary).
  learn: (word: string) => void;
}

// How many suggestions to offer, matching the browser's menu.
const MAX_SUGGESTIONS = 5;

// spellingMenuItems is the top of the right-click menu on a misspelled word
// in a text field, like the browser's: the spellchecker's suggestions (or
// "No Guesses Found"), then Learn Spelling / Add to Dictionary. Electron
// underlines misspellings but shows no menu of its own, so without this the
// suggestions were unreachable in the desktop app. Empty anywhere else.
export function spellingMenuItems(
  params: Pick<ContextMenuParams, 'isEditable' | 'misspelledWord' | 'dictionarySuggestions'>,
  actions: SpellingActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const word = params.misspelledWord;
  if (!params.isEditable || !word) return [];
  const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
  const items: MenuItemConstructorOptions[] =
    suggestions.length > 0
      ? suggestions.map((suggestion) => ({ label: suggestion, click: () => actions.replace(suggestion) }))
      : [{ label: 'No Guesses Found', enabled: false }];
  items.push(
    { type: 'separator' },
    {
      // Each OS's own wording for the same action.
      label: platform === 'darwin' ? 'Learn Spelling' : 'Add to Dictionary',
      click: () => actions.learn(word),
    },
  );
  return items;
}
