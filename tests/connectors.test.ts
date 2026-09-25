import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchRunConnectors, syncConnectors, type RunnerConnector, credentialHeader } from '../src/runner/connectors';

const noop = () => {};

function mkConnector(overrides: Partial<RunnerConnector> = {}): RunnerConnector {
  return {
    slug: 'cliffhub',
    title: 'CliffHub',
    description: 'Team ops platform.',
    baseURL: 'https://api.example.com',
    envPrefix: 'CLIFFHUB',
    token: 'tok-secret-1',
    files: [
      { name: 'index.yml', content: 'schema: 1' },
      { name: '_catalog.tsv', content: 'people.index\tGET api/people\tread-only\tuser\tList people\t' },
      { name: 'people.yaml', content: 'service: people\nendpoints: []\n' },
      // The server injects this (or the bundle ships it); the runner never
      // generates one.
      { name: '_USAGE.md', content: 'server-authored usage doc' },
    ],
    ...overrides,
  };
}

describe('syncConnectors', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-test-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the bundle docs verbatim and returns creds + priority instructions', () => {
    const setup = syncConnectors(root, [mkConnector()], noop);

    const dir = path.join(root, 'cliffhub');
    expect(fs.readFileSync(path.join(dir, 'index.yml'), 'utf8')).toBe('schema: 1');
    expect(fs.existsSync(path.join(dir, '_catalog.tsv'))).toBe(true);

    // _USAGE.md is written by the SERVER and synced verbatim — the runner has
    // no generator of its own, so the document cannot drift between the two.
    const usage = fs.readFileSync(path.join(dir, '_USAGE.md'), 'utf8');
    expect(usage).toBe('server-authored usage doc');

    // Credentials go to the MCP server env payload — never to disk, never to
    // the harness shell.
    const creds = JSON.parse(setup.mcpConnectors) as Array<Record<string, string>>;
    expect(creds).toEqual([
      { slug: 'cliffhub', title: 'CliffHub', baseURL: 'https://api.example.com', token: 'tok-secret-1' },
    ]);
    for (const f of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain('tok-secret-1');
    }

    // The preamble is the PRIORITY frame: names the service, the catalog-grep
    // workflow, the tool-only rule, and forbids wandering + oversharing.
    expect(setup.instructions).toContain('PRIORITY path');
    expect(setup.instructions).toContain('/cliffhub — CliffHub');
    expect(setup.instructions).toContain('connector_lookup');
    expect(setup.instructions).not.toContain('read _USAGE.md');
    expect(setup.instructions).toContain('connector_call is the only way in');
    expect(setup.instructions).toContain('first call');
    expect(setup.instructions).toContain('_identity.json');
    expect(setup.instructions).not.toContain('tok-secret-1');
  });

  it('skips path-traversal file names', () => {
    const setup = syncConnectors(
      root,
      [mkConnector({ files: [{ name: '../evil.yml', content: 'x' }, { name: 'ok.yml', content: 'y' }] })],
      noop,
    );
    expect(fs.existsSync(path.join(root, 'evil.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'cliffhub', 'ok.yml'))).toBe(true);
    expect(setup.instructions).toContain('PRIORITY');
  });

  it('prunes files removed from the registry and shows the multi-service header', () => {
    const dir = path.join(root, 'cliffhub');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.yaml'), 'removed upstream');
    fs.mkdirSync(path.join(dir, 'subdir')); // directories are left alone
    const pruned: string[] = [];
    const log = (msg: string, fields?: Record<string, unknown>) => {
      if (msg === 'connector file pruned') pruned.push(String(fields?.file));
    };
    const hub = mkConnector({
      slug: 'hub',
      title: 'Hub',
      files: [{ name: '_catalog.tsv', content: 'x\tGET /x' }], // no _USAGE.md → logged, not invented
    });
    const withServices = mkConnector({
      files: [
        { name: 'index.yml', content: 'schema: 1' },
        { name: '_USAGE.md', content: '# Using it\n\n## Services\n- crm — customers and leads\n- people — employees\n\n## Next\nprose' },
      ],
    });
    const setup = syncConnectors(root, [withServices, hub], log);
    expect(pruned).toEqual(['stale.yaml']);
    expect(fs.existsSync(path.join(dir, 'stale.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'subdir'))).toBe(true);
    // Two services attached → the pick-ONE-domain instruction rides the preamble,
    // and a bundle whose _USAGE.md carries a service map gets it inlined.
    expect(setup.instructions).toContain('pick the ONE whose domain owns the question');
    expect(setup.instructions).toContain('Services (route prefixes):');
    expect(setup.instructions).toContain('- crm — customers and leads');
  });

  it('tolerates a file that cannot be pruned (locked): it lingers until next sync', () => {
    const dir = path.join(root, 'cliffhub');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.yaml'), 'x');
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('EBUSY');
    });
    try {
      expect(() => syncConnectors(root, [mkConnector()], noop)).not.toThrow();
    } finally {
      unlink.mockRestore();
    }
  });

  it('returns empty setup for no connectors', () => {
    const setup = syncConnectors(root, [], noop);
    expect(setup.mcpConnectors).toBe('');
    expect(setup.instructions).toBe('');
  });
});

describe('credentialHeader', () => {
  it('defaults to Authorization: Bearer and renders every accepted template shape', () => {
    expect(credentialHeader(undefined, 'tok')).toEqual(['Authorization', 'Bearer tok']);
    expect(credentialHeader('   ', 'tok')).toEqual(['Authorization', 'Bearer tok']);
    expect(credentialHeader('X-Api-Key: {token}', 'mb_1')).toEqual(['X-Api-Key', 'mb_1']);
    expect(credentialHeader('X-Api-Key', 'mb_1')).toEqual(['X-Api-Key', 'mb_1']);
    expect(credentialHeader('X-Api-Key:', 'mb_1')).toEqual(['X-Api-Key', 'mb_1']);
    expect(credentialHeader('Authorization: Token', 't')).toEqual(['Authorization', 'Token t']);
    expect(credentialHeader('Authorization: Basic {token} extra', 'b')).toEqual(['Authorization', 'Basic b extra']);
  });

  it('rides the MCP credential payload so connector_call can honour it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ex-conn-auth-'));
    const setup = syncConnectors(
      dir,
      [
        {
          slug: 'metabase', title: 'Metabase', description: 'BI', baseURL: 'https://mb.example.net/api',
          envPrefix: 'METABASE', token: 'mb_secret', authHeader: 'X-Api-Key: {token}',
          files: [{ name: 'index.yml', content: 'schema: 1' }],
        },
        {
          slug: 'hub', title: 'Hub', description: 'ops', baseURL: 'https://hub.example.net',
          envPrefix: 'HUB', token: 'tok', files: [{ name: 'index.yml', content: 'schema: 1' }],
        },
      ],
      () => {},
    );
    const creds = JSON.parse(setup.mcpConnectors) as { slug: string; authHeader?: string }[];
    expect(creds.find((c) => c.slug === 'metabase')?.authHeader).toBe('X-Api-Key: {token}');
    expect(creds.find((c) => c.slug === 'hub')?.authHeader).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('fetchRunConnectors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pulls the run connectors with the run token', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ connectors: [{ slug: 'hub' }] }),
    });
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRunConnectors('https://ex.example', 'run-tok')).resolves.toEqual([{ slug: 'hub' }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://ex.example/api/v1/agent/run/connectors');
    expect(init.headers.authorization).toBe('Bearer run-tok');
  });

  it('returns [] for a body without connectors and throws on a refused fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
    await expect(fetchRunConnectors('https://ex.example', 't')).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(fetchRunConnectors('https://ex.example', 't')).rejects.toThrow('connectors fetch failed: 401');
  });
});
