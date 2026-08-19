import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { extractOperations, loadSpec } from '../src/openapi.js';
import {
  SpecError,
  cacheIsStale,
  diffIsEmpty,
  diffOperations,
  fetchSpec,
  loadActiveSpec,
  readSpecCache,
  specMaxAgeHours,
  specUrl,
  summariseDiff,
  validateSpec,
  writeSpecCache,
} from '../src/spec.js';
import { modifiedSpec } from './modified-spec.js';

const BUNDLED = loadSpec();

async function tempFile(name = 'spec.json'): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'informer-spec-')), name);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('validateSpec', () => {
  it('accepts the bundled document', () => {
    expect(validateSpec(BUNDLED).openapi).toBe('3.0.0');
  });

  it.each([
    ['a string', 'not a document'],
    ['a document without a version', { paths: { '/a': {} } }],
    ['a swagger 2 document', { swagger: '2.0', paths: { '/a': {} } }],
    ['a document without paths', { openapi: '3.0.0' }],
    ['a document with no paths at all', { openapi: '3.0.0', paths: {} }],
    ['a document with no usable operations', { openapi: '3.0.0', paths: { '/a': { options: {} } } }],
  ])('rejects %s', (_label, candidate) => {
    expect(() => validateSpec(candidate)).toThrow(SpecError);
  });
});

describe('fetchSpec', () => {
  it('returns the validated document', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, BUNDLED));
    await expect(fetchSpec('https://example.test/spec.json', fetchImpl)).resolves.toMatchObject({ openapi: '3.0.0' });
  });

  it('reports an HTTP error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: 'down' }));
    await expect(fetchSpec('https://example.test/spec.json', fetchImpl)).rejects.toThrow(/returned HTTP 503/);
  });

  it('reports a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, '<html>captive portal</html>'));
    await expect(fetchSpec('https://example.test/spec.json', fetchImpl)).rejects.toThrow(/did not return JSON/);
  });

  it('reports a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    await expect(fetchSpec('https://example.test/spec.json', fetchImpl)).rejects.toThrow(/Could not reach/);
  });

  it('refuses a valid-JSON document that is not an API description', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { message: 'maintenance' }));
    await expect(fetchSpec('https://example.test/spec.json', fetchImpl)).rejects.toThrow(SpecError);
  });
});

describe('the cache', () => {
  it('round-trips a document', async () => {
    const path = await tempFile();
    await writeSpecCache(path, BUNDLED, 'https://example.test/spec.json', '2026-08-19T10:00:00.000Z');

    const cached = readSpecCache(path);
    expect(cached?.fetchedAt).toBe('2026-08-19T10:00:00.000Z');
    expect(cached?.url).toBe('https://example.test/spec.json');
    expect(Object.keys(cached?.spec.paths ?? {})).toHaveLength(Object.keys(BUNDLED.paths).length);
  });

  it('ignores a damaged cache rather than failing', async () => {
    const path = await tempFile();
    await writeFile(path, '{ not json');
    expect(readSpecCache(path)).toBeUndefined();
  });

  it('ignores a cache holding something that is not an API description', async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify({ spec: { hello: 'world' }, fetchedAt: 'x', url: 'y' }));
    expect(readSpecCache(path)).toBeUndefined();
  });

  it('falls back to the bundled document when there is no cache', async () => {
    const active = loadActiveSpec({ INFORMER_SPEC_CACHE: await tempFile('absent.json') });
    expect(active.source).toBe('bundled');
  });

  it('prefers a valid cache over the bundled document', async () => {
    const path = await tempFile();
    await writeSpecCache(path, modifiedSpec(), 'https://example.test/spec.json', '2026-08-19T10:00:00.000Z');

    const active = loadActiveSpec({ INFORMER_SPEC_CACHE: path });
    expect(active.source).toBe('cache');
    expect(active.spec.paths['/widgets']).toBeDefined();
  });
});

describe('staleness', () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse('2026-08-19T12:00:00.000Z');

  it('treats a missing cache as stale', async () => {
    expect(cacheIsStale({ INFORMER_SPEC_CACHE: await tempFile('absent.json') }, NOW)).toBe(true);
  });

  it('leaves a fresh cache alone', async () => {
    const path = await tempFile();
    await writeSpecCache(path, BUNDLED, 'u', new Date(NOW - 2 * HOUR).toISOString());
    expect(cacheIsStale({ INFORMER_SPEC_CACHE: path }, NOW)).toBe(false);
  });

  it('considers an old cache stale', async () => {
    const path = await tempFile();
    await writeSpecCache(path, BUNDLED, 'u', new Date(NOW - 30 * HOUR).toISOString());
    expect(cacheIsStale({ INFORMER_SPEC_CACHE: path }, NOW)).toBe(true);
  });

  it('never refreshes when the maximum age is zero', async () => {
    const env = { INFORMER_SPEC_CACHE: await tempFile('absent.json'), INFORMER_SPEC_MAX_AGE_HOURS: '0' };
    expect(specMaxAgeHours(env)).toBe(0);
    expect(cacheIsStale(env, NOW)).toBe(false);
  });

  it('falls back to the default for nonsense', () => {
    expect(specMaxAgeHours({ INFORMER_SPEC_MAX_AGE_HOURS: 'soon' })).toBe(24);
    expect(specMaxAgeHours({})).toBe(24);
  });
});

describe('specUrl', () => {
  it('defaults to the published document and honours an override', () => {
    expect(specUrl({})).toBe('https://api.informer.eu/docs/v2/api-docs.json');
    expect(specUrl({ INFORMER_SPEC_URL: 'https://example.test/s.json' })).toBe('https://example.test/s.json');
  });
});

describe('diffOperations', () => {
  const before = extractOperations(BUNDLED);
  const after = extractOperations(modifiedSpec());
  const diff = diffOperations(before, after);

  it('finds nothing between a document and itself', () => {
    const same = diffOperations(before, before);
    expect(diffIsEmpty(same)).toBe(true);
    expect(same.unchanged).toBe(before.length);
    expect(summariseDiff(same)).toBe('no changes');
  });

  it('reports a new endpoint as a new tool', () => {
    expect(diff.added).toContainEqual({ tool: 'get_widgets', endpoint: 'GET /widgets' });
  });

  it('reports a withdrawn endpoint', () => {
    expect(diff.removed).toContainEqual({ tool: 'list_products', endpoint: 'GET /products' });
  });

  it('explains a newly required body field', () => {
    const changed = diff.changed.find((entry) => entry.tool === 'create_sales_invoice');
    expect(changed?.notes).toContain('body now requires: project_id');
  });

  it('summarises in one line', () => {
    expect(summariseDiff(diff)).toMatch(/\d+ added, \d+ removed, \d+ changed/);
  });
});
