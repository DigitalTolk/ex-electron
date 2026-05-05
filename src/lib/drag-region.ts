// Without a native title bar (titleBarStyle: 'hiddenInset' on macOS,
// 'hidden' + titleBarOverlay on Win/Linux) the OS has no built-in drag
// affordance around the chat SPA's top search bar. The chat shell wraps
// that bar in a <header>, so we mark the header as a window drag region
// and opt common interactive controls back out — the search input,
// buttons and links inside the header stay clickable, and the empty
// space around them moves/zooms the window via the OS's native title-bar
// drag and double-click gestures.
export const CHAT_DRAG_REGION_CSS = `
  header {
    -webkit-app-region: drag;
  }
  input, textarea, select, button, a,
  [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="tab"],
  [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"] {
    -webkit-app-region: no-drag;
  }
`;
