/**
 * Runtime configuration, read from the environment and an optional JSON file.
 *
 * The server can serve several client administrations at once. Each one has its
 * own API key and security code, because Informer scopes both to a single
 * administration; there is no API-level way to switch between them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Whether an administration may be written to. */
export type AccessMode = 'read-only' | 'read-write';

/** Credentials for one Informer administration. */
export interface Administration {
  /** Short handle used as the `administration` tool argument, e.g. `acme`. */
  alias: string;
  /** Human-readable name shown in tool descriptions. */
  label?: string;
  apiKey: string;
  securityCode: string;
  /** Restricts this client to reading. Cannot widen a server-wide read-only clamp. */
  mode?: AccessMode;
}

export interface Config {
  /** Configured administrations, keyed by alias. May be empty. */
  administrations: Record<string, Administration>;
  /** API root, without trailing slash. */
  baseUrl: string;
  /** Server-wide clamp: when true, every administration is read-only regardless of its own mode. */
  readOnly: boolean;
  /** Optional allowlist of OpenAPI tags and/or tool names. Empty = everything. */
  include: string[];
  /** Optional denylist of OpenAPI tags and/or tool names, applied after `include`. */
  exclude: string[];
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Number of retries for 429 / 5xx responses and network errors. */
  maxRetries: number;
  /** Tool results longer than this are truncated with a notice. */
  maxResponseChars: number;
  /** How many administrations a fan-out query queries at the same time. */
  fanoutConcurrency: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const DEFAULT_BASE_URL = 'https://api.informer.eu/v2';
const DEFAULT_CONFIG_FILE = join(homedir(), '.informer-mcp.json');
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/** Reserved as the "every administration" selector, so it cannot be an alias. */
export const ALL_ADMINISTRATIONS = 'all';

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${label} must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  return Math.floor(parsed);
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const READ_ONLY_WORDS = new Set(['read-only', 'readonly', 'read_only', 'ro']);
const READ_WRITE_WORDS = new Set(['read-write', 'readwrite', 'read_write', 'rw', 'write']);

/** Accepts `"mode": "read-only"` and the shorthand `"read_only": true`. */
function parseMode(record: Record<string, unknown>, origin: string, alias: string): AccessMode | undefined {
  const flag = record.read_only ?? record.readOnly;
  if (typeof flag === 'boolean') return flag ? 'read-only' : 'read-write';

  const mode = record.mode ?? record.access;
  if (mode === undefined) return undefined;
  if (typeof mode !== 'string') {
    throw new ConfigError(`${origin}: administration "${alias}" has a non-string "mode".`);
  }

  const normalized = mode.trim().toLowerCase();
  if (READ_ONLY_WORDS.has(normalized)) return 'read-only';
  if (READ_WRITE_WORDS.has(normalized)) return 'read-write';
  throw new ConfigError(
    `${origin}: administration "${alias}" has mode "${mode}". Use "read-only" or "read-write".`,
  );
}

function pick(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Accepts either `{ administrations: { alias: {...} } }` or a bare
 * `{ alias: {...} }` map, with snake_case or camelCase credential keys.
 */
function parseAdministrations(input: unknown, origin: string): Record<string, Administration> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(`${origin} must contain a JSON object of administrations.`);
  }

  const root = input as Record<string, unknown>;
  const nested = root.administrations;
  const entries = (nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : root) as Record<
    string,
    unknown
  >;

  const administrations: Record<string, Administration> = {};

  for (const [alias, raw] of Object.entries(entries)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError(`${origin}: administration "${alias}" must be an object.`);
    }
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ConfigError(
        `${origin}: "${alias}" is not a valid alias. Use letters, digits, hyphens and underscores, e.g. "acme-bv".`,
      );
    }
    if (alias.toLowerCase() === ALL_ADMINISTRATIONS) {
      throw new ConfigError(`${origin}: "${ALL_ADMINISTRATIONS}" is reserved as the "every administration" selector.`);
    }

    const record = raw as Record<string, unknown>;
    const apiKey = pick(record, 'api_key', 'apiKey');
    const securityCode = pick(record, 'security_code', 'securityCode');
    const label = pick(record, 'label', 'name');

    if (!apiKey || !securityCode) {
      throw new ConfigError(`${origin}: administration "${alias}" needs both "api_key" and "security_code".`);
    }

    const mode = parseMode(record, origin, alias);
    administrations[alias] = { alias, apiKey, securityCode, ...(label ? { label } : {}), ...(mode ? { mode } : {}) };
  }

  return administrations;
}

/** The config file this process reads and the setup UI writes. */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.INFORMER_CONFIG_FILE?.trim() || DEFAULT_CONFIG_FILE;
}

/** Validates an administrations object, as parsed from JSON. Exported for the setup UI. */
export function parseAdministrationsInput(input: unknown, origin: string): Record<string, Administration> {
  return parseAdministrations(input, origin);
}

/**
  * A file that is not there yet simply means "no administrations configured" —
  * that is the state `informer-mcp setup` exists to fix, and refusing to start
  * would keep the setup page from ever opening. A file that *is* there but is
  * unreadable stays a hard error.
  */
function readConfigFile(path: string): Record<string, Administration> {
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`${path} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return parseAdministrations(parsed, path);
}

/**
 * Collects administrations from, in increasing order of precedence:
 * the config file, the inline `INFORMER_ADMINISTRATIONS` JSON, and the legacy
 * single-administration `INFORMER_API_KEY` / `INFORMER_SECURITY_CODE` pair.
 */
export function loadAdministrations(env: NodeJS.ProcessEnv): Record<string, Administration> {
  const administrations = readConfigFile(configFilePath(env));

  const inline = env.INFORMER_ADMINISTRATIONS?.trim();
  if (inline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch (cause) {
      throw new ConfigError(
        `INFORMER_ADMINISTRATIONS is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    Object.assign(administrations, parseAdministrations(parsed, 'INFORMER_ADMINISTRATIONS'));
  }

  const apiKey = env.INFORMER_API_KEY?.trim();
  const securityCode = env.INFORMER_SECURITY_CODE?.trim();
  if (apiKey && securityCode) {
    const alias = env.INFORMER_ADMINISTRATION_ALIAS?.trim() || 'default';
    if (!ALIAS_PATTERN.test(alias)) {
      throw new ConfigError(`INFORMER_ADMINISTRATION_ALIAS "${alias}" is not a valid alias.`);
    }
    const mode = env.INFORMER_ADMINISTRATION_MODE?.trim()
      ? parseMode({ mode: env.INFORMER_ADMINISTRATION_MODE }, 'INFORMER_ADMINISTRATION_MODE', alias)
      : undefined;

    administrations[alias] = {
      alias,
      apiKey,
      securityCode,
      ...(env.INFORMER_ADMINISTRATION_LABEL?.trim() ? { label: env.INFORMER_ADMINISTRATION_LABEL.trim() } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  return administrations;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    administrations: loadAdministrations(env),
    baseUrl: (env.INFORMER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    readOnly: bool(env.INFORMER_READ_ONLY, false),
    include: list(env.INFORMER_TOOLS),
    exclude: list(env.INFORMER_EXCLUDE_TOOLS),
    timeoutMs: int(env.INFORMER_TIMEOUT_MS, 30_000, 'INFORMER_TIMEOUT_MS'),
    maxRetries: int(env.INFORMER_MAX_RETRIES, 2, 'INFORMER_MAX_RETRIES'),
    maxResponseChars: int(env.INFORMER_MAX_RESPONSE_CHARS, 100_000, 'INFORMER_MAX_RESPONSE_CHARS'),
    fanoutConcurrency: Math.max(1, int(env.INFORMER_FANOUT_CONCURRENCY, 4, 'INFORMER_FANOUT_CONCURRENCY')),
  };
}

export function administrationAliases(config: Config): string[] {
  return Object.keys(config.administrations).sort();
}

/** True when no credentials at all were configured. */
export function hasCredentials(config: Config): boolean {
  return administrationAliases(config).length > 0;
}

/**
 * The effective access mode for one administration.
 *
 * The most restrictive setting wins: a server-wide read-only switch cannot be
 * opted out of per client, while a client marked read-only stays read-only on a
 * read-write server.
 */
export function accessMode(config: Config, alias: string): AccessMode {
  if (config.readOnly) return 'read-only';
  return config.administrations[alias]?.mode ?? 'read-write';
}

/** Aliases this server is allowed to write to. */
export function writableAliases(config: Config): string[] {
  return administrationAliases(config).filter((alias) => accessMode(config, alias) === 'read-write');
}

export const NO_CREDENTIALS_MESSAGE =
  'No Informer administration is configured. Set INFORMER_API_KEY and INFORMER_SECURITY_CODE for a single ' +
  'administration, or list several in ~/.informer-mcp.json (or the file named by INFORMER_CONFIG_FILE). ' +
  'API keys are created per administration at https://app.informer.eu/settings/api/ and the security code ' +
  'is shown at https://app.informer.eu/settings/account/.';
