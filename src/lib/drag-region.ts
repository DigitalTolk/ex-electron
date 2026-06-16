// Without a native title bar (titleBarStyle: 'hiddenInset' on macOS,
// 'hidden' + titleBarOverlay on Win/Linux) the OS has no built-in drag
// affordance around the chat SPA's top search bar. The chat shell marks
// that one bar with data-app-chrome="true", so we scope the window drag
// region to that element and opt common interactive controls back out —
// the search input, buttons and links inside it stay clickable, and the
// empty space around them moves/zooms the window via the OS's native
// title-bar drag and double-click gestures.
//
// This MUST NOT be a blanket `header` rule: the SPA renders many other
// <header> elements (per-thread cards on /threads, channel/conversation
// headers, the thread panel). A drag region swallows wheel events, so a
// blanket rule left the page stuck whenever the cursor sat over any of
// those headers — only the real title bar should drag.
export const CHAT_DRAG_REGION_CSS = `
  [data-app-chrome="true"] {
    -webkit-app-region: drag;
  }
  input, textarea, select, button, a,
  [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="tab"],
  [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"] {
    -webkit-app-region: no-drag;
  }
`;
