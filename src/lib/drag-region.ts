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
//
// -webkit-app-region: drag is also inherited by descendants, and a drag
// region swallows wheel events. When the chrome bar wraps scrollable content
// (the sidebar with its categories/channels), the gaps between rows inherit
// drag and become unscrollable — interactive rows still work because they
// match the no-drag selectors, but the empty space between them does not. So
// `[data-app-chrome="true"] *` opts every descendant back out: only the bar's
// own empty area drags, everything inside it stays clickable and scrollable.
export const CHAT_DRAG_REGION_CSS = `
  [data-app-chrome="true"] {
    -webkit-app-region: drag;
  }
  [data-app-chrome="true"] * {
    -webkit-app-region: no-drag;
  }
  input, textarea, select, button, a,
  [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="tab"],
  [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"] {
    -webkit-app-region: no-drag;
  }
`;
