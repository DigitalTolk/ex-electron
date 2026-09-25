// Connector support: when the invoking message picked services with /slug
// tokens, pull the invoker's installed connector bundles from the backend
// (run-token scoped), sync the docs to disk, and produce:
//   - mcpConnectors: the credential payload for the MCP server (EX_CONNECTORS
//     env). API calls happen through the connector_call tool — auto-allowed,
//     URL pinned to the connector's base, token never visible to the shell.
//   - instructions: a PRIORITY preamble for the top of the task prompt — the
//     auto-attached "connector skill". It teaches surgical doc access (grep the
//     catalog, read ONE endpoint block) so the multi-thousand-line YAMLs never
//     land in context wholesale.
// Each synced connector ships a server-generated _USAGE.md beside its docs so the
// agent can re-read the workflow locally mid-task without any prompt cost.
import fs from 'node:fs';
import path from 'node:path';

import { servicesFromUsage } from './connector-docs';
import type { RunnerLogger } from './types';

export interface ConnectorFile {
  name: string;
  content: string;
}

export interface RunnerConnector {
  slug: string;
  title: string;
  description: string;
  baseURL: string;
  envPrefix: string;
  token: string;
  // Header template the token rides in — "X-Api-Key: {token}" for Metabase
  // API keys; absent/empty = "Authorization: Bearer {token}".
  authHeader?: string;
  files: ConnectorFile[];
}

// credentialHeader renders a connector's authHeader template into the
// [name, value] pair that carries the token. Mirrors model.RenderAuthHeader
// on the server: "Name: prefix {token}", "Name: {token}", "Name: Prefix"
// (token appended) or a bare "Name" (token as the whole value).
export function credentialHeader(template: string | undefined, token: string): [string, string] {
  const t = (template ?? '').trim() || 'Authorization: Bearer {token}';
  const colon = t.indexOf(':');
  const name = (colon < 0 ? t : t.slice(0, colon)).trim();
  const rest = colon < 0 ? '' : t.slice(colon + 1).trim();
  if (!rest) return [name, token];
  if (rest.includes('{token}')) return [name, rest.split('{token}').join(token)];
  return [name, `${rest} ${token}`];
}

export interface ConnectorSetup {
  // JSON for the MCP server's EX_CONNECTORS env var — empty string when the
  // run has no connectors.
  mcpConnectors: string;
  // Task-priority preamble, prepended to the prompt. Empty when none attached.
  instructions: string;
}

export const EMPTY_CONNECTOR_SETUP: ConnectorSetup = { mcpConnectors: '', instructions: '' };

// fetchRunConnectors pulls the run's connectors with the run token (the
// backend filters to the invoker's installs ∩ the message's /picks).
export async function fetchRunConnectors(baseUrl: string, runToken: string): Promise<RunnerConnector[]> {
  const res = await fetch(`${baseUrl}/api/v1/agent/run/connectors`, {
    headers: { authorization: `Bearer ${runToken}` },
  });
  if (!res.ok) throw new Error(`connectors fetch failed: ${res.status}`);
  const body = (await res.json()) as { connectors?: RunnerConnector[] };
  return body.connectors ?? [];
}

// preamble renders the compact task-top section for all attached connectors.
// Deliberately thin: the workflow rules ride the system prompt (one copy,
// harness/shared.ts connectorRules); what belongs here is what is specific to
// THESE services — their service maps — and the one instruction that makes
// the first turn a connector_lookup instead of a file read.
function preamble(rows: { c: RunnerConnector; dir: string }[]): string {
  const lines: string[] = [
    '[connected services] This task uses the external service(s) below — the PRIORITY path.',
    'Answer from the service API, not from chat history or the local machine.',
    '',
  ];
  if (rows.length > 1) {
    lines.push(
      'Several services are connected: pick the ONE whose domain owns the question and search',
      'only inside it — touch a second only when the question genuinely spans both.',
      '',
    );
  }
  for (const { c, dir } of rows) {
    const usage = c.files.find((f) => f.name.toLowerCase() === '_usage.md');
    const services = usage ? servicesFromUsage(usage.content) : [];
    lines.push(`## /${c.slug} — ${c.title}`, `${c.description}`);
    if (services.length > 0) lines.push('Services (route prefixes):', ...services.slice(0, 20));
    lines.push(
      `Start with connector_lookup(connector: '${c.slug}', query: '<words from the question>') — one call`,
      'returns the matching endpoints, the chosen contract and its enum values. Then ONE complete',
      `connector_call. The invoker's identity on this service: ${dir}/_identity.json (grep the one field`,
      `you need). Full docs: ${dir} — only for what lookup cannot answer.`,
      '',
    );
  }
  lines.push(
    'The connector rules in your system prompt apply: connector_call is the only way in, first call',
    'complete, counts from meta, never cat a saved response file.',
  );
  return lines.join('\n');
}

// syncConnectors writes each connector's docs + generated _USAGE.md under
// rootDir and returns the MCP credential payload + priority instructions.
// Tokens never touch disk and never enter the harness shell.
export function syncConnectors(rootDir: string, connectors: RunnerConnector[], log: RunnerLogger): ConnectorSetup {
  const rows: { c: RunnerConnector; dir: string }[] = [];

  for (const c of connectors) {
    const dir = path.join(rootDir, c.slug);
    fs.mkdirSync(dir, { recursive: true });
    let hasUsage = false;
    for (const f of c.files) {
      // Names are validated server-side (no slashes); belt-and-braces here.
      if (f.name.includes('/') || f.name.includes('..')) continue;
      if (f.name.toLowerCase() === '_usage.md') hasUsage = true;
      fs.writeFileSync(path.join(dir, f.name), f.content, 'utf8');
    }
    // _USAGE.md comes FROM THE BACKEND — server-generated, or admin-authored
    // in the bundle — so instruction tuning reaches every user without an app
    // update. There used to be a second copy of that whole document here as a
    // fallback, which meant the same connector could be explained two
    // different ways depending on which side produced the file. The server
    // owns it; if it ever arrives without one, say so rather than inventing it.
    if (!hasUsage) {
      log('connector bundle has no _USAGE.md', { slug: c.slug });
    }
    // Mirror, don't just overlay: a doc removed from the registry must also
    // vanish from warm thread dirs, or agents keep grepping deleted files
    // forever. Only regular files directly in this connector's dir.
    const keep = new Set([...c.files.map((f) => f.name), '_USAGE.md']);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || keep.has(entry.name)) continue;
      try {
        fs.unlinkSync(path.join(dir, entry.name));
        log('connector file pruned', { slug: c.slug, file: entry.name });
      } catch {
        // Best-effort: a locked file just lingers until the next sync.
      }
    }
    rows.push({ c, dir });
    log('connector synced', { slug: c.slug, files: c.files.length, dir });
  }

  if (rows.length === 0) return EMPTY_CONNECTOR_SETUP;
  const mcpConnectors = JSON.stringify(
    rows.map(({ c }) => ({ slug: c.slug, title: c.title, baseURL: c.baseURL, token: c.token, authHeader: c.authHeader })),
  );
  return { mcpConnectors, instructions: preamble(rows) };
}
