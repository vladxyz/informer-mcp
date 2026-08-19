import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadSpec } from '../src/openapi.js';
import { readSpecCache } from '../src/spec.js';
import { createServer, REFRESH_TOOL, type CreatedServer } from '../src/server.js';
import { modifiedSpec } from './modified-spec.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const NOW = new Date('2026-08-19T12:00:00.000Z');

async function build(body: unknown, status = 200): Promise<{ created: CreatedServer; cache: string }> {
  const cache = join(await mkdtemp(join(tmpdir(), 'informer-refresh-')), 'spec.json');
  const fetchImpl = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

  const created = createServer({
    env: {
      INFORMER_CONFIG_FILE: EMPTY,
      INFORMER_SPEC_CACHE: cache,
      INFORMER_API_KEY: 'k',
      INFORMER_SECURITY_CODE: 'c',
    },
    spec: loadSpec(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
  });

  return { created, cache };
}

describe('refresh_api_spec', () => {
  it('is registered alongside the endpoint tools', async () => {
    const { created } = await build(loadSpec());
    expect(created.toolNames).toContain('list_administrations');
    expect(created.toolNames).toContain('list_products');
    expect(REFRESH_TOOL).toBe('refresh_api_spec');
  });

  it('reports no changes when the published document matches', async () => {
    const { created } = await build(loadSpec());
    const outcome = await created.refresh();

    expect(outcome.adopted).toBe(true);
    expect(outcome.diff.added).toEqual([]);
    expect(outcome.diff.removed).toEqual([]);
    expect(outcome.diff.changed).toEqual([]);
  });

  it('a dry run describes the changes without applying them', async () => {
    const { created, cache } = await build(modifiedSpec());
    const before = created.registry.toolNames().length;

    const outcome = await created.refresh(true);

    expect(outcome.adopted).toBe(false);
    expect(outcome.diff.added.map((entry) => entry.tool)).toContain('get_widgets');
    expect(outcome.diff.removed.map((entry) => entry.tool)).toContain('list_products');
    expect(created.registry.toolNames()).not.toContain('get_widgets');
    expect(created.registry.toolNames()).toHaveLength(before);
    expect(existsSync(cache)).toBe(false);
  });

  it('adopts the document: tools appear, disappear and are re-advertised', async () => {
    const { created } = await build(modifiedSpec());

    const outcome = await created.refresh();

    expect(outcome.adopted).toBe(true);
    expect(created.registry.toolNames()).toContain('get_widgets');
    expect(created.registry.toolNames()).not.toContain('list_products');
    expect(outcome.diff.changed.map((entry) => entry.tool)).toContain('create_sales_invoice');
  });

  it('makes the new tool actually callable', async () => {
    const { created } = await build(modifiedSpec());
    await created.refresh();

    const operation = created.registry.operations().find((entry) => entry.toolName === 'get_widgets');
    expect(operation?.path).toBe('/widgets');
    expect(operation?.method).toBe('get');
  });

  it('writes the cache so the next start begins from the new document', async () => {
    const { created, cache } = await build(modifiedSpec());
    await created.refresh();

    const cached = readSpecCache(cache);
    expect(cached?.fetchedAt).toBe(NOW.toISOString());
    expect(cached?.spec.paths['/widgets']).toBeDefined();
  });

  it('keeps the current tools when the download fails', async () => {
    const { created } = await build({ error: 'maintenance' }, 503);
    const before = created.registry.toolNames();

    await expect(created.refresh()).rejects.toThrow(/HTTP 503/);
    expect(created.registry.toolNames()).toEqual(before);
  });

  it('keeps the current tools when the download is not an API description', async () => {
    const { created } = await build('<html>login page</html>');
    const before = created.registry.toolNames();

    await expect(created.refresh()).rejects.toThrow();
    expect(created.registry.toolNames()).toEqual(before);
  });

  it('does not download when auto-refresh is switched off', async () => {
    const cache = join(await mkdtemp(join(tmpdir(), 'informer-refresh-')), 'spec.json');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const created = createServer({
      env: {
        INFORMER_CONFIG_FILE: EMPTY,
        INFORMER_SPEC_CACHE: cache,
        INFORMER_SPEC_MAX_AGE_HOURS: '0',
      },
      spec: loadSpec(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    created.autoRefresh();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
