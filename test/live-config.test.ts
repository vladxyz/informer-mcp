import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { administrationAliases, loadConfig, writableAliases } from '../src/config.js';
import { loadSpec } from '../src/openapi.js';
import { createServer, SETUP_TOOL } from '../src/server.js';
import { OPERATIONS, harness } from './harness.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/administrations.json', import.meta.url));

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'informer-live-'));
}

async function serverWithConfigAt(configPath: string) {
  const dir = await tempDir();
  return createServer({
    env: {
      INFORMER_CONFIG_FILE: configPath,
      INFORMER_SPEC_CACHE: join(dir, 'spec.json'),
      INFORMER_SPEC_MAX_AGE_HOURS: '0',
    },
    spec: loadSpec(),
  });
}

describe('re-syncing', () => {
  it('touches nothing when neither the spec nor the config moved', () => {
    const app = harness(loadConfig({ INFORMER_CONFIG_FILE: EMPTY }));

    const before = app.listChangedCount;
    const result = app.registry.sync(OPERATIONS);

    expect(result).toEqual({ added: [], removed: [], changed: [] });
    expect(app.listChangedCount - before).toBe(0);
  });

  it('re-advertises every tool once the administrations change, in a single notification', async () => {
    const configPath = join(await tempDir(), 'config.json');
    const config = loadConfig({ INFORMER_CONFIG_FILE: configPath });
    const app = harness(config);

    const before = app.listChangedCount;
    Object.assign(config, loadConfig({ INFORMER_CONFIG_FILE: MULTI }));
    const result = app.registry.sync(OPERATIONS);

    expect(result.changed.length).toBe(app.registry.toolNames().length - 1);
    expect(app.listChangedCount - before).toBe(1);
  });
});

describe('reloadConfig', () => {
  it('picks up an administration written after the server started', async () => {
    const configPath = join(await tempDir(), 'config.json');
    const created = await serverWithConfigAt(configPath);

    expect(administrationAliases(created.config)).toEqual([]);

    await writeFile(
      configPath,
      JSON.stringify({ administrations: { acme: { label: 'ACME BV', api_key: 'k', security_code: 'c' } } }),
    );
    created.reloadConfig();

    expect(administrationAliases(created.config)).toEqual(['acme']);
    expect(created.config.administrations.acme?.label).toBe('ACME BV');
  });

  it('picks up a client that was switched to read-only', async () => {
    const configPath = join(await tempDir(), 'config.json');
    await writeFile(configPath, JSON.stringify({ administrations: { acme: { api_key: 'k', security_code: 'c' } } }));

    const created = await serverWithConfigAt(configPath);
    expect(writableAliases(created.config)).toEqual(['acme']);

    await writeFile(
      configPath,
      JSON.stringify({ administrations: { acme: { api_key: 'k', security_code: 'c', mode: 'read-only' } } }),
    );
    created.reloadConfig();

    expect(writableAliases(created.config)).toEqual([]);
  });

  it('leaves the config alone when the file became unreadable', async () => {
    const configPath = join(await tempDir(), 'config.json');
    await writeFile(configPath, JSON.stringify({ administrations: { acme: { api_key: 'k', security_code: 'c' } } }));

    const created = await serverWithConfigAt(configPath);
    await writeFile(configPath, '{ broken');

    expect(() => created.reloadConfig()).toThrow();
    expect(administrationAliases(created.config)).toEqual(['acme']);
  });
});

describe('the setup tool', () => {
  it('is named so a model looking to change administrations finds it', () => {
    expect(SETUP_TOOL).toBe('open_setup');
  });

  it('closes cleanly when no page was opened', async () => {
    const created = await serverWithConfigAt(join(await tempDir(), 'config.json'));
    await expect(created.closeSetup()).resolves.toBeUndefined();
  });
});
