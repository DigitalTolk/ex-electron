// Connector doc lookup — the pure parsing behind the connector_lookup MCP tool.
//
// Before this existed an agent discovered an endpoint by hand: read _USAGE.md,
// grep _catalog.tsv, grep the service .yaml for `id: <route>`, Read ~60 lines
// at that offset, then grep _enums.yaml for each enum the block referenced.
// Five or six model turns (and five re-reads of the whole context) per
// connector before the first API call. connector_lookup does the same walk
// in-process and hands back one result: the matching catalog rows, the chosen
// endpoint's contract block, and the enum values it references.
import fs from 'node:fs';
import path from 'node:path';

export interface CatalogRow {
  routeId: string;
  methodPath: string;
  sideEffects: string;
  audience: string;
  summary: string;
  keywords: string;
  raw: string;
}

// Caps keep one lookup result well inside what a single turn should carry:
// the point is to REPLACE several reads, not to dump a service file whole.
export const LOOKUP_MAX_ROWS = 20;
export const LOOKUP_MAX_BLOCK_LINES = 160;
export const LOOKUP_MAX_BLOCK_CHARS = 9000;
export const LOOKUP_MAX_ENUMS = 8;
export const LOOKUP_MAX_ENUM_LINES = 40;

// parseCatalog reads the provider-generated _catalog.tsv. Columns: route_id,
// "METHOD path", side_effects, audience, summary, keywords — the same six the
// _USAGE.md workflow told the agent to cut with `cut -f1,2,5`.
export function parseCatalog(tsv: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    rows.push({
      routeId: cols[0].trim(),
      // cols[1] exists whenever length >= 2; the ?? is a type-level guard.
      /* v8 ignore next */
      methodPath: (cols[1] ?? '').trim(),
      sideEffects: (cols[2] ?? '').trim(),
      audience: (cols[3] ?? '').trim(),
      summary: (cols[4] ?? '').trim(),
      keywords: (cols[5] ?? '').trim(),
      raw: line,
    });
  }
  return rows;
}

// searchCatalog ranks rows by how many query words hit the whole line (the
// same visibility a `grep -i` had), optionally scoped to a route prefix
// ("one_on_ones" matches one_on_ones.*). audience: internal endpoints are
// machine-to-machine and never offered — the old doc said so in prose, this
// enforces it.
export function searchCatalog(rows: CatalogRow[], query: string, service?: string): CatalogRow[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9_:/-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  const prefix = service ? `${service.trim().toLowerCase().replace(/\.\*?$/, '')}.` : '';
  const scored: { row: CatalogRow; hits: number; bonus: number }[] = [];
  for (const row of rows) {
    if (row.audience.toLowerCase() === 'internal') continue;
    if (prefix && !row.routeId.toLowerCase().startsWith(prefix)) continue;
    const hay = row.raw.toLowerCase();
    let hits = 0; // distinct query words present anywhere on the line
    let bonus = 0; // of those, how many land in the route id or summary
    for (const w of words) {
      if (!hay.includes(w)) continue;
      hits += 1;
      if (row.routeId.toLowerCase().includes(w) || row.summary.toLowerCase().includes(w)) bonus += 1;
    }
    if (hits > 0) scored.push({ row, hits, bonus });
  }
  scored.sort((a, b) => b.hits - a.hits || b.bonus - a.bonus || a.row.routeId.localeCompare(b.row.routeId));
  // Relevance cutoff: when some rows match two or more of the words, rows
  // matching just one are noise — "meetings today list" hit 18 rows in a
  // meetings-heavy catalog before this, all but one on the word "meetings".
  const best = scored.length > 0 ? scored[0].hits : 0;
  const kept = best >= 2 ? scored.filter((s) => s.hits >= 2) : scored;
  return kept.slice(0, LOOKUP_MAX_ROWS).map((s) => s.row);
}

export interface EndpointBlock {
  file: string;
  line: number; // 1-based line of the `- id:` marker
  text: string;
  truncated: boolean;
}

// readOptional reads a doc file that may legitimately be absent (a KB with
// no enums, a connector attached before its sync finished) — null, not throw.
export function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// findEndpointBlock locates `- id: <routeId>` in the service YAMLs and
// returns that endpoint's block: from the marker down to the next sibling
// `- id:` (same or shallower indent), a top-level key, or the cap. Comment
// separator lines between endpoints are dropped.
export function findEndpointBlock(dir: string, routeId: string): EndpointBlock | null {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f) && f !== '_enums.yaml' && f !== 'index.yml')
      .sort();
  } catch {
    return null;
  }
  const marker = new RegExp(`^(\\s*)-\\s*id:\\s*['"]?${escapeRegExp(routeId)}['"]?\\s*$`);
  for (const f of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const m = marker.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      const out: string[] = [lines[i]];
      let truncated = false;
      let chars = lines[i].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        const sib = /^(\s*)-\s*id:\s*\S/.exec(l);
        if (sib && sib[1].length <= indent) break;
        if (indent > 0 && /^\S/.test(l) && !l.startsWith('#')) break; // next top-level key
        if (/^\s*#\s*-{5,}\s*$/.test(l)) continue; // "# -----" separators
        if (out.length >= LOOKUP_MAX_BLOCK_LINES || chars + l.length > LOOKUP_MAX_BLOCK_CHARS) {
          truncated = true;
          break;
        }
        out.push(l);
        chars += l.length + 1;
      }
      // Trim trailing blank lines.
      while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
      return { file: f, line: i + 1, text: out.join('\n'), truncated };
    }
  }
  return null;
}

// enumRefs lists the `enum:<name>` references a block carries, in order of
// first appearance, deduplicated and capped.
export function enumRefs(block: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /enum:([A-Za-z0-9_.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= LOOKUP_MAX_ENUMS) break;
  }
  return out;
}

// enumBlock extracts one top-level `<name>:` mapping from _enums.yaml text —
// its values plus the notes the KB author left (which value means "this
// week", which is applied to created_at…). Capped per enum.
export function enumBlock(enumsYaml: string, name: string): string | null {
  const lines = enumsYaml.split('\n');
  const start = new RegExp(`^${escapeRegExp(name)}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!start.test(lines[i])) continue;
    const out = [lines[i]];
    for (let j = i + 1; j < lines.length && out.length < LOOKUP_MAX_ENUM_LINES; j++) {
      if (/^\S/.test(lines[j])) break;
      out.push(lines[j]);
    }
    while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }
  return null;
}

// servicesFromUsage pulls the "## Services" bullet list out of a
// server-generated _USAGE.md — the one connector-specific part of that doc.
// The rest of it is workflow boilerplate that now lives in the system rules,
// so the attach result can carry this list inline instead of sending the
// agent off to read the file.
export function servicesFromUsage(usage: string): string[] {
  const lines = usage.split('\n');
  const out: string[] = [];
  let inServices = false;
  for (const l of lines) {
    if (/^##\s+Services/i.test(l)) {
      inServices = true;
      continue;
    }
    if (inServices && /^##\s/.test(l)) break;
    if (inServices && /^\s*-\s+\S/.test(l)) out.push(l.trim());
  }
  return out;
}

export interface LookupInput {
  dir: string; // the connector's synced docs folder
  slug: string;
  query?: string;
  routeId?: string;
  service?: string;
}

// lookup renders the connector_lookup result: matching rows for a query,
// the contract block (plus referenced enums) for a route id — or for a query
// that matches exactly one endpoint, both at once.
export function lookup(input: LookupInput): { text: string; isError: boolean } {
  const { dir, slug } = input;
  const query = (input.query ?? '').trim();
  let routeId = (input.routeId ?? '').trim();
  if (!query && !routeId) {
    return { text: 'connector_lookup needs query (words from the question) and/or route_id', isError: true };
  }
  const catalog = readOptional(path.join(dir, '_catalog.tsv'));
  if (catalog === null) {
    return { text: `no catalog found for ${slug} — call use_connector first`, isError: true };
  }
  const rows = parseCatalog(catalog);
  const parts: string[] = [];

  if (query) {
    const hits = searchCatalog(rows, query, input.service);
    if (hits.length === 0) {
      const scope = input.service ? ` in service ${input.service}` : '';
      parts.push(`no ${slug} endpoints match "${query}"${scope}. Try fewer or different words${input.service ? ', or drop the service scope' : ''}.`);
    } else {
      parts.push(`${hits.length} ${slug} endpoint(s) match "${query}" (route_id | METHOD path | side_effects | summary):`);
      for (const h of hits) parts.push(`${h.routeId} | ${h.methodPath} | ${h.sideEffects} | ${h.summary}`);
      if (!routeId && hits.length === 1) routeId = hits[0].routeId;
      else if (!routeId) parts.push('Pick the one whose SCOPE matches the question and call connector_lookup again with its route_id for the contract.');
    }
  }

  if (routeId) {
    const row = rows.find((r) => r.routeId === routeId);
    if (row && row.audience.toLowerCase() === 'internal') {
      parts.push(`${routeId} is audience: internal (machine-to-machine) — never call it; pick a user-facing endpoint.`);
      return { text: parts.join('\n'), isError: false };
    }
    const block = findEndpointBlock(dir, routeId);
    if (!block) {
      parts.push(`no contract block found for route_id "${routeId}"${row ? '' : ' (not in the catalog either — check the spelling)'}`);
      return { text: parts.join('\n'), isError: !row };
    }
    parts.push('', `--- contract: ${routeId} (${block.file}:${block.line}) ---`, block.text);
    if (block.truncated) parts.push(`… (block truncated at ${LOOKUP_MAX_BLOCK_LINES} lines; the rest is in ${path.join(dir, block.file)} from line ${block.line})`);
    const refs = enumRefs(block.text);
    if (refs.length > 0) {
      const enums = readOptional(path.join(dir, '_enums.yaml'));
      const found: string[] = [];
      const missing: string[] = [];
      for (const name of refs) {
        const b = enums ? enumBlock(enums, name) : null;
        if (b) found.push(b);
        else missing.push(name);
      }
      if (found.length > 0) parts.push('', '--- enums referenced (the ONLY valid values) ---', ...found);
      if (missing.length > 0) parts.push(`(enum(s) not found in _enums.yaml: ${missing.join(', ')})`);
    }
    parts.push('', 'Compose ONE complete connector_call from this contract: every constraint in the question → a documented filter above.');
  }
  return { text: parts.join('\n'), isError: false };
}
