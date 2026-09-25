import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enumBlock,
  enumRefs,
  findEndpointBlock,
  lookup,
  parseCatalog,
  searchCatalog,
  servicesFromUsage,
} from '../src/runner/connector-docs';

const CATALOG = [
  'meetings.upcoming\tGET upcoming-meetings\tread-only\tuser\tList the caller\'s next calendar events from Outlook.\tcalendar outlook today schedule',
  'meetings.show\tGET meetings/{meeting}\tread-only\tuser\tPoll one meeting for its processing status and summary text.\tstatus summary',
  'meetings_internal.logs\tGET meetings/{meeting}/logs\tread-only\tinternal\tRead a meeting\'s activity log.\tlog audit',
  'one_on_ones.index\tGET api/one-on-ones\tread-only\t\tList the 1:1 meetings visible to the current user.\t1:1 one-on-one',
].join('\n');

const MEETINGS_YAML = `service: meetings
endpoints:
  - id: meetings.show
    method: GET
    path: "meetings/{meeting}"
    summary: Poll one meeting.

  # -------------------------------------------------------------------------
  - id: meetings.upcoming
    method: GET
    path: "upcoming-meetings"
    summary: List the caller's next calendar events from Outlook.
    filters:
      none: "Accepts no query parameters."

  # -------------------------------------------------------------------------
  - id: meetings.series_history
    method: GET
    path: "meetings/series-history"
`;

const ONE_ON_ONES_YAML = `- id: one_on_ones.index
  method: GET
  path: api/one-on-ones
  params:
    - name: date
      type: enum
      values: enum:one_on_one_date_ranges
    - name: tab
      values: enum:one_on_one_list_tabs
- id: one_on_ones.show
  method: GET
`;

const ENUMS_YAML = `one_on_one_list_tabs:
  values:
  - mine
  - team
one_on_one_date_ranges:
  values:
  - all
  - last_7_days
  source: OneOnOneMeetingController.php:32
  notes: Applied to created_at, not meeting_date.
one_on_one_limits:
  values:
    per_page_max: 100
`;

const USAGE_MD = `# Using the MeetingMind API (connector: meetingmind)

Records meetings.

## Services — pick the OWNER first, search only inside it

- desktop (desktop.yaml) [routes: desktop.*] — Desktop release feed.
- meetings (meetings.yaml) [routes: meetings.*] — Meeting lifecycle for the desktop app.

Scope catalog greps by the [routes: …] prefixes.

## Workflow (in order)

1. Conventions: index.yml.
- not a service line
`;

describe('connector-docs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-connector-docs-'));
    fs.writeFileSync(path.join(dir, '_catalog.tsv'), CATALOG);
    fs.writeFileSync(path.join(dir, 'meetings.yaml'), MEETINGS_YAML);
    fs.writeFileSync(path.join(dir, 'one-on-ones.yaml'), ONE_ON_ONES_YAML);
    fs.writeFileSync(path.join(dir, '_enums.yaml'), ENUMS_YAML);
    fs.writeFileSync(path.join(dir, 'index.yml'), 'schema: 1\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('parses the six catalog columns and skips blank lines', () => {
    const rows = parseCatalog(`${CATALOG}\n\n`);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ routeId: 'meetings.upcoming', methodPath: 'GET upcoming-meetings', audience: 'user' });
    expect(rows[3].audience).toBe('');
  });

  it('ranks query hits, hides internal endpoints and honours a service scope', () => {
    const rows = parseCatalog(CATALOG);
    const hits = searchCatalog(rows, 'meetings today calendar');
    expect(hits.map((r) => r.routeId)[0]).toBe('meetings.upcoming');
    expect(hits.some((r) => r.routeId === 'meetings_internal.logs')).toBe(false);
    expect(searchCatalog(rows, 'meeting', 'one_on_ones').map((r) => r.routeId)).toEqual(['one_on_ones.index']);
    expect(searchCatalog(rows, 'meeting', 'one_on_ones.*').map((r) => r.routeId)).toEqual(['one_on_ones.index']);
    expect(searchCatalog(rows, '   ')).toEqual([]);
    // Relevance cutoff: 'meetings today list' hits every meetings.* row on
    // "meetings"; only upcoming also carries "today" — the rest are dropped.
    const ranked = searchCatalog(rows, 'meetings today list').map((r) => r.routeId);
    expect(ranked[0]).toBe('meetings.upcoming'); // 3 words hit
    expect(ranked).toContain('one_on_ones.index'); // "meetings" + "List" — 2 words
    expect(ranked).not.toContain('meetings.show'); // "meetings" only — cut
    // With no multi-word hit anywhere, single-word matches all survive.
    expect(searchCatalog(rows, 'meetings').length).toBeGreaterThan(1);
  });

  it('extracts an indented endpoint block up to the next sibling and drops separators', () => {
    const block = findEndpointBlock(dir, 'meetings.upcoming');
    expect(block).not.toBeNull();
    expect(block!.file).toBe('meetings.yaml');
    expect(block!.line).toBe(9);
    expect(block!.text).toContain('path: "upcoming-meetings"');
    expect(block!.text).toContain('none: "Accepts no query parameters."');
    expect(block!.text).not.toContain('series_history');
    expect(block!.text).not.toContain('# ----');
    expect(block!.truncated).toBe(false);
  });

  it('extracts a column-0 block and stops at the next top-level id', () => {
    const block = findEndpointBlock(dir, 'one_on_ones.index');
    expect(block!.file).toBe('one-on-ones.yaml');
    expect(block!.text).toContain('enum:one_on_one_date_ranges');
    expect(block!.text).not.toContain('one_on_ones.show');
    expect(findEndpointBlock(dir, 'nope.missing')).toBeNull();
    expect(findEndpointBlock(path.join(dir, 'does-not-exist'), 'x')).toBeNull();
  });

  it('lists enum references once, in order, and pulls their blocks from _enums.yaml', () => {
    const block = findEndpointBlock(dir, 'one_on_ones.index')!;
    expect(enumRefs(`${block.text}\nvalues: enum:one_on_one_date_ranges`)).toEqual([
      'one_on_one_date_ranges',
      'one_on_one_list_tabs',
    ]);
    const e = enumBlock(ENUMS_YAML, 'one_on_one_date_ranges')!;
    expect(e).toContain('- last_7_days');
    expect(e).toContain('notes: Applied to created_at');
    expect(e).not.toContain('one_on_one_limits');
    expect(enumBlock(ENUMS_YAML, 'missing')).toBeNull();
  });

  it('reads only the service bullets out of _USAGE.md', () => {
    expect(servicesFromUsage(USAGE_MD)).toEqual([
      '- desktop (desktop.yaml) [routes: desktop.*] — Desktop release feed.',
      '- meetings (meetings.yaml) [routes: meetings.*] — Meeting lifecycle for the desktop app.',
    ]);
    expect(servicesFromUsage('no services here')).toEqual([]);
  });

  it('lookup: a query with one hit returns rows + contract + enums in one result', () => {
    const out = lookup({ dir, slug: 'cliffhub', query: 'one-on-one 1:1' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('1 cliffhub endpoint(s) match');
    expect(out.text).toContain('--- contract: one_on_ones.index (one-on-ones.yaml:1) ---');
    expect(out.text).toContain('--- enums referenced');
    expect(out.text).toContain('- last_7_days');
    expect(out.text).toContain('Compose ONE complete connector_call');
  });

  it('lookup: several hits list rows and ask for a route_id; route_id alone returns the block', () => {
    const many = lookup({ dir, slug: 'meetingmind', query: 'meeting' });
    expect(many.text).toContain('endpoint(s) match');
    expect(many.text).toContain('call connector_lookup again with its route_id');
    expect(many.text).not.toContain('--- contract');
    const one = lookup({ dir, slug: 'meetingmind', routeId: 'meetings.upcoming' });
    expect(one.text).toContain('--- contract: meetings.upcoming (meetings.yaml:9) ---');
    expect(one.text).not.toContain('--- enums');
  });

  it('lookup: refuses internal endpoints, reports unknown ids and missing input', () => {
    expect(lookup({ dir, slug: 'mm', routeId: 'meetings_internal.logs' }).text).toContain('audience: internal');
    const unknown = lookup({ dir, slug: 'mm', routeId: 'nope.missing' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('not in the catalog either');
    expect(lookup({ dir, slug: 'mm' }).isError).toBe(true);
    expect(lookup({ dir: path.join(dir, 'nope'), slug: 'mm', query: 'x' }).text).toContain('call use_connector first');
    expect(lookup({ dir, slug: 'mm', query: 'zzzz', service: 'desktop' }).text).toContain('drop the service scope');
  });
});

// Edge fixtures with their own tmp dir — deliberately separate from the main
// fixture so ranking expectations above stay untouched.
describe('connector-docs edges', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-connector-docs-edge-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('parseCatalog tolerates short rows: missing columns read as empty', () => {
    const rows = parseCatalog('lonely\na.b\tGET /x\n');
    expect(rows).toHaveLength(1); // one-column line skipped
    expect(rows[0]).toMatchObject({ routeId: 'a.b', methodPath: 'GET /x', sideEffects: '', audience: '', summary: '', keywords: '' });
  });

  it('findEndpointBlock skips unreadable yaml entries and stops at a top-level key', () => {
    fs.mkdirSync(path.join(dir, 'broken.yaml')); // a directory: readFileSync throws → skipped
    fs.writeFileSync(path.join(dir, 'svc.yaml'), 'eps:\n  - id: x.y\n    p: 1\n\ntop: v\n');
    const block = findEndpointBlock(dir, 'x.y')!;
    expect(block.text).toContain('p: 1');
    expect(block.text).not.toContain('top: v');
    expect(block.truncated).toBe(false);
  });

  it('caps a runaway endpoint block and says where the rest lives', () => {
    const body = `eps:\n  - id: big.one\n${'    k: v\n'.repeat(200)}`;
    fs.writeFileSync(path.join(dir, 'svc.yaml'), body);
    fs.writeFileSync(path.join(dir, '_catalog.tsv'), 'big.one\tGET /big\tread-only\tuser\tBig block\tbig\n');
    const block = findEndpointBlock(dir, 'big.one')!;
    expect(block.truncated).toBe(true);
    const out = lookup({ dir, slug: 'svc', routeId: 'big.one' });
    expect(out.text).toContain('block truncated at 160 lines');
  });

  it('enumRefs caps how many enums one block can pull in', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `enum:e${i}`).join(' ');
    expect(enumRefs(refs)).toHaveLength(8);
  });

  it('lookup names found enums and lists the ones _enums.yaml lacks', () => {
    fs.writeFileSync(path.join(dir, '_catalog.tsv'), 'p.q\tGET /pq\tread-only\tuser\tThing\tthing\n');
    fs.writeFileSync(path.join(dir, 'svc.yaml'), '- id: p.q\n  filter: enum:present enum:absent\n');
    fs.writeFileSync(path.join(dir, '_enums.yaml'), 'present:\n  - a\n  - b\n');
    const out = lookup({ dir, slug: 'svc', routeId: 'p.q' });
    expect(out.text).toContain('--- enums referenced');
    expect(out.text).toContain('present:');
    expect(out.text).toContain('enum(s) not found in _enums.yaml: absent');
  });

  it('lookup with no _enums.yaml at all reports every referenced enum as missing', () => {
    fs.writeFileSync(path.join(dir, '_catalog.tsv'), 'p.q\tGET /pq\tread-only\tuser\tThing\tthing\n');
    fs.writeFileSync(path.join(dir, 'svc.yaml'), '- id: p.q\n  filter: enum:orphan\n');
    const out = lookup({ dir, slug: 'svc', routeId: 'p.q' });
    expect(out.text).not.toContain('--- enums referenced');
    expect(out.text).toContain('enum(s) not found in _enums.yaml: orphan');
  });

  it('lookup reports a cataloged route whose contract block is missing — not an error', () => {
    fs.writeFileSync(path.join(dir, '_catalog.tsv'), 'ghost.route\tGET /g\tread-only\tuser\tGhost\tghost\n');
    fs.writeFileSync(path.join(dir, 'svc.yaml'), '- id: other.route\n  p: 1\n');
    const out = lookup({ dir, slug: 'svc', routeId: 'ghost.route' });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('no contract block found for route_id "ghost.route"');
    expect(out.text).not.toContain('not in the catalog either');
  });

  it('lookup: unscoped miss suggests different words; explicit route_id skips the pick prompt', () => {
    fs.writeFileSync(path.join(dir, '_catalog.tsv'), 'a.one\tGET /1\tread-only\tuser\tmeeting list\tmeeting\nb.two\tGET /2\tread-only\tuser\tmeeting board\tmeeting\n');
    fs.writeFileSync(path.join(dir, 'svc.yaml'), '- id: a.one\n  p: 1\n- id: b.two\n  p: 2\n');
    const miss = lookup({ dir, slug: 'svc', query: 'zzzz' });
    expect(miss.text).toContain('Try fewer or different words.');
    expect(miss.text).not.toContain('drop the service scope');
    const picked = lookup({ dir, slug: 'svc', query: 'meeting', routeId: 'b.two' });
    expect(picked.text).toContain('--- contract: b.two');
    expect(picked.text).not.toContain('call connector_lookup again');
  });
});
