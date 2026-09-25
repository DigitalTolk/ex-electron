import { describe, expect, it } from 'vitest';

import { SpillStore, SPILL_FETCH_MAX, SPILL_HEAD, SPILL_TAIL } from '../src/runner/spill';

describe('SpillStore', () => {
  it('passes small results through unchanged', () => {
    const s = new SpillStore();
    expect(s.maybeSpill('get_thread', 'short result')).toBe('short result');
  });

  it('spills oversized results into a preview with head, tail, and locator', () => {
    const s = new SpillStore(100); // tiny inline cap for the test
    const full = 'H'.repeat(SPILL_HEAD) + 'M'.repeat(5000) + 'T'.repeat(SPILL_TAIL);
    const out = s.maybeSpill('search_messages', full);
    expect(out).not.toBe(full);
    expect(out).toContain('sp-1');
    expect(out).toContain(`${full.length} chars`);
    expect(out).toContain('H'.repeat(SPILL_HEAD)); // head preserved
    expect(out).toContain('T'.repeat(SPILL_TAIL)); // tail preserved
    expect(out).not.toContain('M'.repeat(5000)); // middle omitted
    expect(out.length).toBeLessThan(full.length);
  });

  it('fetch returns slices with paging metadata, clamped to the fetch cap', () => {
    const s = new SpillStore(10);
    const full = 'x'.repeat(SPILL_FETCH_MAX * 2 + 500);
    s.maybeSpill('read_channel', full);

    const first = s.fetch('sp-1', 0, SPILL_FETCH_MAX * 10); // over-ask is clamped
    expect(first.isError).toBe(false);
    expect(first.text).toContain(`chars 0–${SPILL_FETCH_MAX}`);
    expect(first.text).toContain(`next offset ${SPILL_FETCH_MAX}`);

    const last = s.fetch('sp-1', SPILL_FETCH_MAX * 2, 1000);
    expect(last.isError).toBe(false);
    expect(last.text).toContain('End of result.');
  });

  it('rejects unknown locators and out-of-range offsets legibly', () => {
    const s = new SpillStore(10);
    s.maybeSpill('t', 'y'.repeat(50));
    expect(s.fetch('sp-99').isError).toBe(true);
    expect(s.fetch('sp-99').text).toContain('unknown spill locator');
    const past = s.fetch('sp-1', 10_000);
    expect(past.isError).toBe(true);
    expect(past.text).toContain('past the end');
  });

  it('evicts oldest entries once the total cap is exceeded', () => {
    const s = new SpillStore(10, 100); // total cap 100 chars
    s.maybeSpill('a', '1'.repeat(60)); // sp-1
    s.maybeSpill('b', '2'.repeat(60)); // sp-2 → total 120 → evict sp-1
    expect(s.fetch('sp-1').isError).toBe(true);
    expect(s.fetch('sp-2').isError).toBe(false);
  });
});
