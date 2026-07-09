// Without a native title bar (titleBarStyle: 'hiddenInset' on macOS,
// 'hidden' + titleBarOverlay on Win/Linux) the OS has no built-in drag
// affordance around the chat SPA's top search bar, so we inject one.
//
// data-app-chrome="true" looks like a title-bar marker but ISN'T: the SPA
// stamps it on every sidebar-coloured surface — the top search bar
// (a <header>), the update/notification banners, and the three channel
// sidebars (desktop/compact/mobile <aside>s). Targeting the bare attribute
// therefore also turned the scrollable sidebars into drag regions, and since
// a drag region swallows wheel events the channel list became unscrollable in
// the gaps between rows. The previous fix papered over that by opting every
// descendant back out (`[data-app-chrome="true"] *`) — but that also stripped
// drag from the top bar's own layout containers (the left/right grid columns),
// so the empty space on either side of the search field, where you'd normally
// grab the window, stopped dragging.
//
// The top bar is the ONLY <header> carrying data-app-chrome, so
// `header[data-app-chrome="true"]` selects it and nothing else. Only that one
// (non-scrollable) strip becomes the drag region; the sidebars are left alone
// and scroll normally, so no blanket descendant opt-out is needed. The bar's
// container <div>s inherit the drag region — their empty space drags the window
// — while the interactive controls below opt back out so they stay clickable.
// (no-drag only has any effect inside a drag region, so scoping these to the
// header buys nothing; leaving them global keeps the list short.)
export const CHAT_DRAG_REGION_CSS = `
  header[data-app-chrome="true"] {
    -webkit-app-region: drag;
  }
  input, textarea, select, button, a,
  [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="menuitem"], [role="tab"],
  [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"] {
    -webkit-app-region: no-drag;
  }
`;
