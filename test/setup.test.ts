import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../src/config.js';
import { buildAdministrations, existingRows, startSetupServer, type SetupServer } from '../src/setup.js';

const servers: SetupServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function tempConfigPath(contents?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'informer-mcp-'));
  const path = join(dir, 'config.json');
  if (contents !== undefined) await writeFile(path, JSON.stringify(contents));
  return path;
}

function apiResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function start(path: string, fetchImpl?: typeof fetch) {
  const server = await startSetupServer({
    env: { INFORMER_CONFIG_FILE: path },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  servers.push(server);

  const token = new URL(server.url).searchParams.get('t') as string;
  const save = (body: unknown) =>
    fetch(`http://127.0.0.1:${server.port}/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-informer-token': token },
      body: JSON.stringify(body),
    });

  return { server, token, save };
}

const ROW = { alias: 'acme', label: 'ACME BV', apiKey: 'key-1', securityCode: 'code-1', mode: 'read-write' };

describe('buildAdministrations', () => {
  const existing = { acme: { alias: 'acme', apiKey: 'old-key', securityCode: 'old-code' } };

  it('maps a form row onto the config shape', () => {
    expect(buildAdministrations([ROW], {})).toEqual({
      acme: { label: 'ACME BV', api_key: 'key-1', security_code: 'code-1' },
    });
  });

  it('records a read-only client', () => {
    const built = buildAdministrations([{ ...ROW, mode: 'read-only' }], {}) as Record<string, { mode?: string }>;
    expect(built.acme?.mode).toBe('read-only');
  });

  it('keeps the stored credentials when the fields are left blank', () => {
    const built = buildAdministrations([{ alias: 'acme', keepExisting: true }], existing) as Record<
      string,
      { api_key: string }
    >;
    expect(built.acme?.api_key).toBe('old-key');
  });

  it('prefers a newly typed credential over the stored one', () => {
    const built = buildAdministrations([{ alias: 'acme', apiKey: 'new', securityCode: 'new', keepExisting: true }], existing) as Record<string, { api_key: string }>;
    expect(built.acme?.api_key).toBe('new');
  });

  it('refuses a half-filled row', () => {
    expect(() => buildAdministrations([{ alias: 'acme', apiKey: 'only-key' }], {})).toThrow(ConfigError);
  });

  it('refuses an empty form', () => {
    expect(() => buildAdministrations([{ alias: '' }], {})).toThrow(/at least one administration/);
  });
});

describe('existingRows', () => {
  it('never exposes stored secrets', async () => {
    const path = await tempConfigPath({
      administrations: { acme: { label: 'ACME BV', api_key: 'secret', security_code: 'secret', mode: 'read-only' } },
    });

    expect(existingRows({ INFORMER_CONFIG_FILE: path })).toEqual([
      { alias: 'acme', label: 'ACME BV', mode: 'read-only', hasCredentials: true },
    ]);
  });

  it('survives a broken config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'informer-mcp-'));
    const path = join(dir, 'broken.json');
    await writeFile(path, '{not json');
    expect(existingRows({ INFORMER_CONFIG_FILE: path })).toEqual([]);
  });
});

describe('the setup server', () => {
  it('serves the page only with the right token', async () => {
    const { server, token } = await start(await tempConfigPath());

    const denied = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(denied.status).toBe(403);

    const allowed = await fetch(`http://127.0.0.1:${server.port}/?t=${token}`);
    const html = await allowed.text();
    expect(allowed.status).toBe(200);
    expect(html).toContain('Informer MCP setup');
  });

  it('does not put stored credentials in the page', async () => {
    const path = await tempConfigPath({
      administrations: { acme: { api_key: 'super-secret-key', security_code: 'super-secret-code' } },
    });
    const { server, token } = await start(path);

    const html = await (await fetch(`http://127.0.0.1:${server.port}/?t=${token}`)).text();
    expect(html).toContain('acme');
    expect(html).not.toContain('super-secret-key');
    expect(html).not.toContain('super-secret-code');
  });

  it('rejects a save without the token', async () => {
    const { server } = await start(await tempConfigPath());

    const response = await fetch(`http://127.0.0.1:${server.port}/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ administrations: [ROW], verify: false }),
    });

    expect(response.status).toBe(403);
  });

  it('writes the config file and resolves saved', async () => {
    const path = await tempConfigPath();
    const { save, server } = await start(path);

    const body = (await (await save({ administrations: [ROW], verify: false })).json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(path);
    await expect(server.saved).resolves.toBe(path);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      administrations: { acme: { label: 'ACME BV', api_key: 'key-1', security_code: 'code-1' } },
    });
  });

  it('verifies the credentials against the API before saving', async () => {
    const path = await tempConfigPath();
    const fetchImpl = vi.fn(async () => apiResponse(200, { company_name: 'ACME BV' })) as unknown as typeof fetch;
    const { save } = await start(path, fetchImpl);

    const body = (await (await save({ administrations: [ROW], verify: true })).json()) as {
      ok: boolean;
      results: { alias: string; company_name?: string }[];
    };

    expect(body.ok).toBe(true);
    expect(body.results[0]).toMatchObject({ alias: 'acme', ok: true, company_name: 'ACME BV' });
    expect(await readFile(path, 'utf8')).toContain('key-1');
  });

  it('refuses to save credentials the API rejects', async () => {
    const path = await tempConfigPath();
    const fetchImpl = vi.fn(async () => apiResponse(401, { error: 'Authentication failed' })) as unknown as typeof fetch;
    const { save } = await start(path, fetchImpl);

    const body = (await (await save({ administrations: [ROW], verify: true })).json()) as {
      ok: boolean;
      error: string;
      results: { ok: boolean; error?: string }[];
    };

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Could not reach acme/);
    expect(body.results[0]?.error).toMatch(/401/);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  it('reports a bad alias instead of writing it', async () => {
    const path = await tempConfigPath();
    const { save } = await start(path);

    const body = (await (await save({ administrations: [{ ...ROW, alias: 'acme bv!' }], verify: false })).json()) as {
      ok: boolean;
      error: string;
    };

    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not a valid alias/);
  });

  it('answers 404 elsewhere', async () => {
    const { server } = await start(await tempConfigPath());
    expect((await fetch(`http://127.0.0.1:${server.port}/whatever`)).status).toBe(404);
  });
});
