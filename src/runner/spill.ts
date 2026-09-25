// Spill store: oversized tool results are persisted here instead of being
// dumped inline (wasting context) or silently truncated (losing data — the
// old failure mode). The model gets a head/tail PREVIEW plus an opaque
// locator it can page through with the fetch_spill tool. Idea adapted from
// DeepSeek Harness's spill subsystem.
//
// Offsets/lengths are in CHARACTERS (JS string indices) — the units the
// model sees in the preview — not bytes. The store lives in the per-run MCP
// server process, so entries share the run's lifetime; a modest total cap
// evicts oldest-first as a runaway backstop.

// Results longer than this are spilled. Generous: most tool results fit far
// under it, so only genuinely huge dumps (whole-thread reads, big searches)
// take the preview path.
export const SPILL_INLINE_MAX = 16_384;
// Preview kept inline when spilling: enough head to act on, a tail so the
// model can see how the result ends (lists, summaries, closing state).
export const SPILL_HEAD = 4_096;
export const SPILL_TAIL = 1_024;
// Per-fetch slice cap — paging through a spill costs one tool round per
// SPILL_FETCH_MAX chars.
export const SPILL_FETCH_MAX = 16_384;
// Total chars retained across all entries before oldest-first eviction.
const SPILL_TOTAL_MAX = 32 * 1024 * 1024;

export class SpillStore {
  private entries = new Map<string, string>(); // locator → full text (insertion-ordered)
  private seq = 0;
  private total = 0;

  constructor(
    private readonly inlineMax = SPILL_INLINE_MAX,
    private readonly totalMax = SPILL_TOTAL_MAX,
  ) {}

  // maybeSpill returns the text unchanged when it fits inline; otherwise it
  // stores the full text and returns the preview + retrieval instructions.
  maybeSpill(toolName: string, text: string): string {
    if (text.length <= this.inlineMax) return text;
    this.seq += 1;
    const locator = `sp-${this.seq}`;
    this.entries.set(locator, text);
    this.total += text.length;
    this.evict();

    const head = text.slice(0, SPILL_HEAD);
    const tail = text.slice(text.length - SPILL_TAIL);
    const omitted = text.length - SPILL_HEAD - SPILL_TAIL;
    return (
      `[${toolName} returned ${text.length} chars — too large to inline. ` +
      `Showing the first ${SPILL_HEAD} and last ${SPILL_TAIL}. The FULL result is stored: ` +
      `read more with fetch_spill(locator="${locator}", offset=<char offset>, length=<≤${SPILL_FETCH_MAX}>). ` +
      `Only fetch what the task actually needs.]\n` +
      head +
      `\n…[${omitted} chars omitted — fetch_spill "${locator}" offset ${SPILL_HEAD}]…\n` +
      tail
    );
  }

  // fetch returns one slice of a spilled result, clamped to SPILL_FETCH_MAX,
  // with position metadata so the model can keep paging.
  fetch(locator: string, offset = 0, length = SPILL_FETCH_MAX): { text: string; isError: boolean } {
    const full = this.entries.get(locator);
    if (full === undefined) {
      return { text: `unknown spill locator "${locator}" — locators only live for this run`, isError: true };
    }
    const start = Math.max(0, Math.floor(offset));
    if (start >= full.length) {
      return { text: `offset ${start} is past the end (${full.length} chars total)`, isError: true };
    }
    const len = Math.min(Math.max(1, Math.floor(length)), SPILL_FETCH_MAX);
    const slice = full.slice(start, start + len);
    const end = start + slice.length;
    const more = end < full.length ? ` More remains: next offset ${end}.` : ' End of result.';
    return { text: `[${locator} chars ${start}–${end} of ${full.length}]${more}\n${slice}`, isError: false };
  }

  // evict drops oldest entries until under the total cap — a runaway backstop,
  // not an expected path.
  private evict(): void {
    for (const [loc, text] of this.entries) {
      if (this.total <= this.totalMax) return;
      this.entries.delete(loc);
      this.total -= text.length;
    }
  }
}
