import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  InformerApiError,
  InformerClient,
  InformerConfigError,
  buildPath,
  buildQuery,
  formatApiError,
} from '../src/client.js';
import { loadConfig, type Config } from '../src/config.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/administrations.json', import.meta.url));

function singleConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_API_KEY: 'key', INFORMER_SECURITY_CODE: 'code' }),
    maxRetries: 0,
    ...overrides,
  };
}

function multiConfig(): Config {
  return { ...loadConfig({ INFORMER_CONFIG_FILE: MULTI }), maxRetries: 0 };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('buildPath', () => {
  it('substitutes and encodes parameters', () => {
    expect(buildPath('/invoices/sales/{id}', { id: 42 })).toBe('/invoices/sales/42');
    expect(buildPath('/a/{x}/b/{y}', { x: 'a b', y: 1 })).toBe('/a/a%20b/b/1');
  });

  it('rejects missing parameters', () => {
    expect(() => buildPath('/relations/{id}', {})).toThrow(InformerConfigError);
  });
});

describe('buildQuery', () => {
  it('skips empty values and repeats arrays', () => {
    expect(buildQuery({ page: 2, search: '', missing: undefined, tag: ['a', 'b'] })).toBe('?page=2&tag=a&tag=b');
  });

  it('returns an empty string when there is nothing to send', () => {
    expect(buildQuery({})).toBe('');
  });
});

describe('formatApiError', () => {
  it('handles the string, array and validation shapes', () => {
    expect(formatApiError(404, { error: 'Not found' })).toBe('HTTP 404: Not found');
    expect(formatApiError(400, { error: ['a', 'b'] })).toBe('HTTP 400: a; b');
    expect(formatApiError(422, { error: { relation_id: 'is verplicht.' } })).toBe('HTTP 422: relation_id: is verplicht.');
    expect(formatApiError(500, undefined)).toBe('HTTP 500');
  });
});

describe('InformerClient', () => {
  it('sends both authentication headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = new InformerClient(singleConfig(), fetchImpl);

    await client.request({ method: 'get', path: '/relations/{id}', pathParams: { id: 7 }, query: { page: 2 } });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.informer.eu/v2/relations/7?page=2');
    expect(init.headers).toMatchObject({ Apikey: 'key', Securitycode: 'code', Accept: 'application/json' });
  });

  it('serialises a JSON body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 1 }));
    const client = new InformerClient(singleConfig(), fetchImpl);

    await client.request({ method: 'post', path: '/relations', body: { company_name: 'ACME' } });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"company_name":"ACME"}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('throws a readable error for a 422', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { error: { invoice_date: 'ongeldig' }, response_code: 422 }));
    const client = new InformerClient(singleConfig(), fetchImpl);

    await expect(client.request({ method: 'post', path: '/invoices/sales', body: {} })).rejects.toThrow(
      '[default] HTTP 422: invoice_date: ongeldig',
    );
  });

  it('retries transient failures and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = new InformerClient(singleConfig({ maxRetries: 1 }), fetchImpl);

    await expect(client.request({ method: 'get', path: '/administration' })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'Resource niet gevonden.' }));
    const client = new InformerClient(singleConfig({ maxRetries: 3 }), fetchImpl);

    await expect(client.request({ method: 'get', path: '/relations/{id}', pathParams: { id: 1 } })).rejects.toBeInstanceOf(
      InformerApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('points at the setup tool when the credentials are rejected', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: 'Authentication failed' }));
      const client = new InformerClient(singleConfig(), fetchImpl);

      await expect(client.request({ method: 'get', path: '/administration' })).rejects.toThrow(
        /Informer rejected the credentials for "default".*open_setup/s,
      );
    }
  });

  it('does not add that hint to failures setup cannot fix', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'Resource niet gevonden.' }));
    const client = new InformerClient(singleConfig(), fetchImpl);

    await expect(client.request({ method: 'get', path: '/relations/{id}', pathParams: { id: 1 } })).rejects.toThrow(
      '[default] HTTP 404: Resource niet gevonden.',
    );
  });

  it('refuses to call the API without credentials', async () => {
    const client = new InformerClient(loadConfig({ INFORMER_CONFIG_FILE: EMPTY }), vi.fn());
    await expect(client.request({ method: 'get', path: '/administration' })).rejects.toThrow(/INFORMER_API_KEY/);
  });
});

describe('InformerClient with several administrations', () => {
  it('uses the credentials of the requested administration', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = new InformerClient(multiConfig(), fetchImpl);

    await client.request({ method: 'get', path: '/administration', administration: 'bakkerij' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Apikey: 'bol-key', Securitycode: 'bol-code' });
  });

  it('refuses to guess which client to act on', async () => {
    const fetchImpl = vi.fn();
    const client = new InformerClient(multiConfig(), fetchImpl);

    await expect(client.request({ method: 'get', path: '/administration' })).rejects.toThrow(
      /"administration" argument is required.*acme, bakkerij/s,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unknown alias without calling the API', async () => {
    const fetchImpl = vi.fn();
    const client = new InformerClient(multiConfig(), fetchImpl);

    await expect(client.request({ method: 'get', path: '/administration', administration: 'nope' })).rejects.toThrow(
      /Unknown administration "nope". Configured aliases: acme, bakkerij/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tags errors with the administration they came from', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'Resource niet gevonden.' }));
    const client = new InformerClient(multiConfig(), fetchImpl);

    await expect(
      client.request({ method: 'get', path: '/relations/{id}', pathParams: { id: 1 }, administration: 'acme' }),
    ).rejects.toThrow('[acme] HTTP 404: Resource niet gevonden.');
  });

  it('still allows the argument to be omitted when only one is configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const client = new InformerClient(singleConfig(), fetchImpl);

    await expect(client.request({ method: 'get', path: '/administration' })).resolves.toEqual({ ok: true });
  });
});
