import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RequestOptions } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { mapWithConcurrency, resolveTargets, supportsFanout } from '../src/tools.js';
import { OPERATIONS, harness } from './harness.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/administrations.json', import.meta.url));

const multi = loadConfig({ INFORMER_CONFIG_FILE: MULTI });

describe('supportsFanout', () => {
  const byName = new Map(OPERATIONS.map((operation) => [operation.toolName, operation]));

  it('allows read-only, non-file operations', () => {
    expect(supportsFanout(byName.get('list_sales_invoices')!)).toBe(true);
    expect(supportsFanout(byName.get('get_balance_report')!)).toBe(true);
  });

  it('refuses writes and file downloads', () => {
    expect(supportsFanout(byName.get('create_sales_invoice')!)).toBe(false);
    expect(supportsFanout(byName.get('update_relation')!)).toBe(false);
    expect(supportsFanout(byName.get('get_sales_invoice_pdf')!)).toBe(false);
    expect(supportsFanout(byName.get('download_sales_invoice_attachment')!)).toBe(false);
  });
});

describe('resolveTargets', () => {
  it('expands "all" to every configured alias', () => {
    expect(resolveTargets('all', multi)).toEqual(['acme', 'bakkerij']);
  });

  it('accepts a single alias and a list', () => {
    expect(resolveTargets('acme', multi)).toEqual(['acme']);
    expect(resolveTargets(['bakkerij', 'acme'], multi)).toEqual(['bakkerij', 'acme']);
  });

  it('de-duplicates a list', () => {
    expect(resolveTargets(['acme', 'acme'], multi)).toEqual(['acme']);
  });

  it('rejects unknown aliases', () => {
    expect(() => resolveTargets(['acme', 'nope'], multi)).toThrow(/Unknown administration\(s\): nope/);
  });

  it('requires a choice when several are configured', () => {
    expect(() => resolveTargets(undefined, multi)).toThrow(/"administration" argument is required/);
  });

  it('defaults to the only administration when there is one', () => {
    const single = loadConfig({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_API_KEY: 'k', INFORMER_SECURITY_CODE: 'c' });
    expect(resolveTargets(undefined, single)).toEqual(['default']);
  });

  it('refuses a list or "all" when fan-out is not allowed', () => {
    expect(() => resolveTargets('all', multi, { fanout: false })).toThrow(/exactly one administration/);
    expect(() => resolveTargets(['acme', 'bakkerij'], multi, { fanout: false })).toThrow(/exactly one administration/);
    expect(resolveTargets('acme', multi, { fanout: false })).toEqual(['acme']);
  });

  it('reports missing credentials rather than an empty choice', () => {
    expect(() => resolveTargets(undefined, loadConfig({ INFORMER_CONFIG_FILE: EMPTY }))).toThrow(/INFORMER_API_KEY/);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and respects the limit', async () => {
    let running = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('fan-out through the registered tool', () => {
  it('returns a single administration unwrapped', async () => {
    const { text } = await harness(multi, async () => ({ pagination: { total: 1 }, relations: [{ id: 1 }] })).call(
      'list_relations',
      { administration: 'acme' },
    );

    expect(JSON.parse(text)).toEqual({ pagination: { total: 1 }, relations: [{ id: 1 }] });
  });

  it('keys results by alias when several are queried', async () => {
    const { call, client } = harness(multi, async (options) => ({ who: options.administration }));
    const { text } = await call('list_relations', { administration: 'all' });

    expect(JSON.parse(text)).toEqual({
      administrations: ['acme', 'bakkerij'],
      results: { acme: { who: 'acme' }, bakkerij: { who: 'bakkerij' } },
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('passes the same query arguments to every administration', async () => {
    const { call, client } = harness(multi, async () => ({}));
    await call('list_sales_invoices', { administration: ['acme', 'bakkerij'], filter: 'open', records: 5 });

    for (const [options] of client.request.mock.calls as [RequestOptions][]) {
      expect(options.query).toEqual({ filter: 'open', records: 5 });
      expect(options.path).toBe('/invoices/sales');
    }
  });

  it('keeps one failing administration from sinking the rest', async () => {
    const { call } = harness(multi, async (options) => {
      if (options.administration === 'bakkerij') throw new Error('[bakkerij] HTTP 401: Authentication failed');
      return { relations: [] };
    });

    const { result, text } = await call('list_relations', { administration: 'all' });
    const parsed = JSON.parse(text) as { results: Record<string, unknown> };

    expect(result.isError).toBeUndefined();
    expect(parsed.results.acme).toEqual({ relations: [] });
    expect(parsed.results.bakkerij).toEqual({ error: '[bakkerij] HTTP 401: Authentication failed' });
  });

  it('gives every administration an equal share of the response budget', async () => {
    const config = { ...multi, maxResponseChars: 200 };
    const { call } = harness(config, async () => ({ padding: 'x'.repeat(500) }));

    const { text } = await call('list_relations', { administration: 'all' });
    const parsed = JSON.parse(text) as { results: Record<string, { truncated?: boolean; partial?: string }> };

    for (const alias of ['acme', 'bakkerij']) {
      expect(parsed.results[alias]?.truncated).toBe(true);
      expect(parsed.results[alias]?.partial?.length).toBe(100);
    }
  });

  it('rejects fan-out arguments on a write tool before calling the API', async () => {
    const { call, client } = harness(multi, async () => ({}));
    const { result, text } = await call('create_relation', { administration: 'all', body: {} });

    expect(result.isError).toBe(true);
    expect(text).toMatch(/runs against exactly one administration/);
    expect(client.request).not.toHaveBeenCalled();
  });
});
