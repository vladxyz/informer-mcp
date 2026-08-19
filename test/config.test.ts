import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ConfigError, administrationAliases, loadAdministrations, loadConfig } from '../src/config.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/administrations.json', import.meta.url));

describe('loadAdministrations', () => {
  it('reads a config file with several administrations', () => {
    const administrations = loadAdministrations({ INFORMER_CONFIG_FILE: MULTI });

    expect(Object.keys(administrations).sort()).toEqual(['acme', 'bakkerij']);
    expect(administrations.acme).toEqual({
      alias: 'acme',
      label: 'ACME BV',
      apiKey: 'acme-key',
      securityCode: 'acme-code',
    });
  });

  it('accepts camelCase credential keys', () => {
    const administrations = loadAdministrations({ INFORMER_CONFIG_FILE: MULTI });
    expect(administrations.bakkerij?.apiKey).toBe('bol-key');
    expect(administrations.bakkerij?.securityCode).toBe('bol-code');
  });

  it('accepts a bare alias map without the wrapper', () => {
    const administrations = loadAdministrations({
      INFORMER_CONFIG_FILE: EMPTY,
      INFORMER_ADMINISTRATIONS: '{"solo":{"api_key":"k","security_code":"c"}}',
    });
    expect(administrations.solo?.apiKey).toBe('k');
  });

  it('folds the legacy single pair into an administration', () => {
    const administrations = loadAdministrations({
      INFORMER_CONFIG_FILE: EMPTY,
      INFORMER_API_KEY: 'key',
      INFORMER_SECURITY_CODE: 'code',
    });
    expect(administrations).toEqual({ default: { alias: 'default', apiKey: 'key', securityCode: 'code' } });
  });

  it('lets the legacy pair be aliased and labelled', () => {
    const administrations = loadAdministrations({
      INFORMER_CONFIG_FILE: EMPTY,
      INFORMER_API_KEY: 'key',
      INFORMER_SECURITY_CODE: 'code',
      INFORMER_ADMINISTRATION_ALIAS: 'acme',
      INFORMER_ADMINISTRATION_LABEL: 'ACME BV',
    });
    expect(administrations.acme?.label).toBe('ACME BV');
  });

  it('lets inline JSON override the config file', () => {
    const administrations = loadAdministrations({
      INFORMER_CONFIG_FILE: MULTI,
      INFORMER_ADMINISTRATIONS: '{"acme":{"api_key":"override","security_code":"c"}}',
    });
    expect(administrations.acme?.apiKey).toBe('override');
    expect(administrations.bakkerij?.apiKey).toBe('bol-key');
  });

  it('yields nothing when no credentials are configured', () => {
    expect(loadAdministrations({ INFORMER_CONFIG_FILE: EMPTY })).toEqual({});
  });

  it('treats a config file that does not exist yet as empty, so setup can create it', () => {
    expect(loadAdministrations({ INFORMER_CONFIG_FILE: 'C:/nope/missing.json' })).toEqual({});
  });

  it('rejects malformed JSON', () => {
    expect(() => loadAdministrations({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_ADMINISTRATIONS: '{oops' })).toThrow(
      /not valid JSON/,
    );
  });

  it('rejects an administration without both credentials', () => {
    expect(() =>
      loadAdministrations({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_ADMINISTRATIONS: '{"a":{"api_key":"k"}}' }),
    ).toThrow(/needs both/);
  });

  it('rejects an alias that cannot be used as an argument value', () => {
    expect(() =>
      loadAdministrations({
        INFORMER_CONFIG_FILE: EMPTY,
        INFORMER_ADMINISTRATIONS: '{"acme bv!":{"api_key":"k","security_code":"c"}}',
      }),
    ).toThrow(/not a valid alias/);
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({ INFORMER_CONFIG_FILE: EMPTY });
    expect(config.baseUrl).toBe('https://api.informer.eu/v2');
    expect(config.readOnly).toBe(false);
    expect(config.maxRetries).toBe(2);
    expect(administrationAliases(config)).toEqual([]);
  });

  it('strips a trailing slash from the base url', () => {
    expect(loadConfig({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_BASE_URL: 'https://example.test/v2/' }).baseUrl).toBe(
      'https://example.test/v2',
    );
  });

  it('rejects a non-numeric timeout', () => {
    expect(() => loadConfig({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_TIMEOUT_MS: 'soon' })).toThrow(ConfigError);
  });
});
