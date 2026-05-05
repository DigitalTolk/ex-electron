// The chat SPA prefixes its tab title with "(N) " when there are unread
// messages. We pull that count out so we can drive the dock badge.
export function parseUnreadCount(title: string): number {
  const m = /^\((\d+)\)\s*/.exec(title);
  return m ? parseInt(m[1], 10) : 0;
}
