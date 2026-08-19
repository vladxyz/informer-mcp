import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, accessMode, loadConfig, writableAliases } from '../src/config.js';
import type { JsonObject } from '../src/openapi.js';
import { allowedAliases, resolveTargets, selectOperations, withAdministration } from '../src/tools.js';
import { OPERATIONS, harness } from './harness.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/administrations.json', import.meta.url));
const MIXED = fileURLToPath(new URL('./fixtures/mixed-modes.json', import.meta.url));

const byName = new Map(OPERATIONS.map((operation) => [operation.toolName, operation]));
const createRelation = byName.get('create_relation')!;
const listRelations = byName.get('list_relations')!;

const single = (env: NodeJS.ProcessEnv = {}) =>
  loadConfig({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_API_KEY: 'k', INFORMER_SECURITY_CODE: 'c', ...env });

describe('access mode', () => {
  it('follows the server-wide default', () => {
    expect(accessMode(single(), 'default')).toBe('read-write');
    expect(accessMode(single({ INFORMER_READ_ONLY: 'true' }), 'default')).toBe('read-only');
  });

  it('restricts a single administration below a read-write default', () => {
    expect(accessMode(single({ INFORMER_ADMINISTRATION_MODE: 'read-only' }), 'default')).toBe('read-only');
  });

  it('cannot be widened past a server-wide read-only clamp', () => {
    expect(accessMode(single({ INFORMER_READ_ONLY: 'true', INFORMER_ADMINISTRATION_MODE: 'read-write' }), 'default')).toBe(
      'read-only',
    );
  });

  it('reads per-client modes from the config file', () => {
    const config = loadConfig({ INFORMER_CONFIG_FILE: MIXED });
    expect(accessMode(config, 'acme')).toBe('read-write');
    expect(accessMode(config, 'bakkerij')).toBe('read-only');
    expect(accessMode(config, 'garage')).toBe('read-write');
    expect(writableAliases(config)).toEqual(['acme', 'garage']);
  });

  it('clamps every administration when the server is read-only', () => {
    const config = loadConfig({ INFORMER_CONFIG_FILE: MIXED, INFORMER_READ_ONLY: 'true' });
    expect(writableAliases(config)).toEqual([]);
  });

  it('accepts the read_only boolean shorthand', () => {
    const config = loadConfig({
      INFORMER_CONFIG_FILE: EMPTY,
      INFORMER_ADMINISTRATIONS: '{"a":{"api_key":"k","security_code":"c","read_only":true}}',
    });
    expect(accessMode(config, 'a')).toBe('read-only');
  });

  it('rejects an unrecognised mode', () => {
    expect(() =>
      loadConfig({
        INFORMER_CONFIG_FILE: EMPTY,
        INFORMER_ADMINISTRATIONS: '{"a":{"api_key":"k","security_code":"c","mode":"maybe"}}',
      }),
    ).toThrow(ConfigError);
  });
});

describe('tool selection', () => {
  const names = (config = single()) => selectOperations(OPERATIONS, config).map((operation) => operation.toolName);

  it('drops every write tool when nothing is writable', () => {
    const selected = names(single({ INFORMER_READ_ONLY: 'true' }));
    expect(selected).toContain('list_relations');
    expect(selected).not.toContain('create_relation');
  });

  it('keeps write tools when at least one administration is writable', () => {
    const selected = names(loadConfig({ INFORMER_CONFIG_FILE: MIXED }));
    expect(selected).toContain('create_relation');
  });

  it('drops them under a server-wide read-only clamp, whatever the clients say', () => {
    const selected = names(loadConfig({ INFORMER_CONFIG_FILE: MIXED, INFORMER_READ_ONLY: 'true' }));
    expect(selected).not.toContain('create_relation');
  });

  it('drops them again when every administration is read-only', () => {
    const config = loadConfig({
      INFORMER_CONFIG_FILE: EMPTY,
      INFORMER_ADMINISTRATIONS: '{"a":{"api_key":"k","security_code":"c","mode":"read-only"}}',
    });
    expect(names(config)).not.toContain('create_relation');
  });
});

describe('the selector on a write tool', () => {
  const mixed = loadConfig({ INFORMER_CONFIG_FILE: MIXED });

  it('only offers the writable administrations', () => {
    expect(allowedAliases(createRelation, mixed)).toEqual(['acme', 'garage']);
    expect(allowedAliases(listRelations, mixed)).toEqual(['acme', 'bakkerij', 'garage']);
  });

  it('narrows the advertised enum', () => {
    const schema = withAdministration(createRelation.inputSchema, mixed, {
      allowed: allowedAliases(createRelation, mixed),
    });
    const selector = (schema.properties as JsonObject).administration as JsonObject;

    expect(selector.enum).toEqual(['acme', 'garage']);
    expect(selector.description).toContain('Writable:');
    expect(selector.description).not.toContain('bakkerij');
  });

  it('still lists every administration for a read tool', () => {
    const schema = withAdministration(listRelations.inputSchema, mixed, {
      fanout: true,
      allowed: allowedAliases(listRelations, mixed),
    });
    const selector = (schema.properties as JsonObject).administration as JsonObject;
    const [asString] = selector.anyOf as JsonObject[];

    expect(asString?.enum).toEqual(['acme', 'bakkerij', 'garage', 'all']);
  });
});

describe('resolveTargets against a read-only client', () => {
  const mixed = loadConfig({ INFORMER_CONFIG_FILE: MIXED });
  const writeOptions = { fanout: false, allowed: writableAliases(mixed) };

  it('explains why a configured administration is refused', () => {
    expect(() => resolveTargets('bakkerij', mixed, writeOptions)).toThrow(
      /bakkerij are configured as read-only.*Writable: acme, garage/s,
    );
  });

  it('still allows a writable one', () => {
    expect(resolveTargets('acme', mixed, writeOptions)).toEqual(['acme']);
  });

  it('reports an unknown alias differently from a read-only one', () => {
    expect(() => resolveTargets('nope', mixed, writeOptions)).toThrow(/Unknown administration/);
  });
});

describe('end to end through the registered tools', () => {
  const mixed = loadConfig({ INFORMER_CONFIG_FILE: MIXED });

  it('refuses a write to a read-only administration without calling the API', async () => {
    const { call, client } = harness(mixed);
    const { result, text } = await call('create_relation', { administration: 'bakkerij', body: {} });

    expect(result.isError).toBe(true);
    expect(text).toMatch(/configured as read-only/);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('allows the write on a writable administration', async () => {
    const { call, client } = harness(mixed, async () => ({ id: 1 }));
    const { result } = await call('create_relation', { administration: 'acme', body: {} });

    expect(result.isError).toBeUndefined();
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('still reads from the read-only administration', async () => {
    const { call, client } = harness(mixed, async () => ({ relations: [] }));
    const { result } = await call('list_relations', { administration: 'bakkerij' });

    expect(result.isError).toBeUndefined();
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('includes it in a fan-out read', async () => {
    const { call } = harness(mixed, async (options) => ({ who: options.administration }));
    const { text } = await call('list_relations', { administration: 'all' });

    expect(Object.keys((JSON.parse(text) as { results: object }).results)).toEqual(['acme', 'bakkerij', 'garage']);
  });

  it('reports the mode of every administration', async () => {
    const { call } = harness(mixed);
    const { text } = await call('list_administrations', {});
    const parsed = JSON.parse(text) as { administrations: { alias: string; mode: string }[]; writable: string[] };

    expect(parsed.administrations.map((entry) => [entry.alias, entry.mode])).toEqual([
      ['acme', 'read-write'],
      ['bakkerij', 'read-only'],
      ['garage', 'read-write'],
    ]);
    expect(parsed.writable).toEqual(['acme', 'garage']);
  });

  it('names the setup tool when an administration cannot be reached', async () => {
    const { call } = harness(mixed, async () => {
      throw new Error('[acme] HTTP 401: Authentication failed');
    });

    const { text } = await call('list_administrations', { verify: true });
    const parsed = JSON.parse(text) as { fix?: string };

    expect(parsed.fix).toMatch(/acme, bakkerij, garage could not be reached/);
    expect(parsed.fix).toMatch(/open_setup/);
  });

  it('leaves the fix hint out when everything answers', async () => {
    const { call } = harness(mixed, async () => ({ company_name: 'ACME BV' }));

    const { text } = await call('list_administrations', { verify: true });
    expect((JSON.parse(text) as { fix?: string }).fix).toBeUndefined();
  });

  it('hides write tools entirely when the whole server is read-only', () => {
    const { has, toolNames } = harness(loadConfig({ INFORMER_CONFIG_FILE: MIXED, INFORMER_READ_ONLY: 'true' }));
    expect(has('list_relations')).toBe(true);
    expect(has('create_relation')).toBe(false);
    expect(toolNames).toContain('list_administrations');
  });
});
