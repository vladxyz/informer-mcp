/**
 * Keeping the OpenAPI document up to date.
 *
 * The vendored `openapi/api-docs.json` is the floor: it always works, offline and
 * without a network round trip. On top of that the server can download the live
 * document from Informer and cache it next to the config file, so a new endpoint
 * becomes a new tool without reinstalling anything.
 *
 * Nothing is scraped. The docs page at api.informer.eu/docs/v2 is a viewer for a
 * machine-readable OpenAPI document; we fetch that document directly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { FetchLike } from './client.js';
import { extractOperations, loadSpec, type OpenApiSpec, type Operation } from './openapi.js';

export const DEFAULT_SPEC_URL = 'https://api.informer.eu/docs/v2/api-docs.json';

const DEFAULT_CACHE_FILE = join(homedir(), '.informer-mcp.spec.json');

export class SpecError extends Error {
  override readonly name = 'SpecError';
}

export interface CachedSpec {
  spec: OpenApiSpec;
  /** ISO timestamp of the download. */
  fetchedAt: string;
  url: string;
}

export interface ActiveSpec {
  spec: OpenApiSpec;
  source: 'cache' | 'bundled';
  fetchedAt?: string;
}

export function specUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.INFORMER_SPEC_URL?.trim() || DEFAULT_SPEC_URL;
}

export function specCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.INFORMER_SPEC_CACHE?.trim() || DEFAULT_CACHE_FILE;
}

/** Hours before a cached document is considered stale. 0 disables auto-refresh. */
export function specMaxAgeHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INFORMER_SPEC_MAX_AGE_HOURS?.trim();
  if (raw === undefined || raw === '') return 24;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 24;
}

/**
 * Refuses anything that is not recognisably the Informer OpenAPI document, so a
 * captive portal or an error page can never replace a working tool set.
 */
export function validateSpec(candidate: unknown): OpenApiSpec {
  if (candidate === null || typeof candidate !== 'object') {
    throw new SpecError('The downloaded document is not a JSON object.');
  }

  const spec = candidate as OpenApiSpec;
  const version = String(spec.openapi ?? '');
  if (!version.startsWith('3.')) {
    throw new SpecError(`Expected an OpenAPI 3 document, got "${version || 'no version'}".`);
  }

  const paths = spec.paths;
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new SpecError('The downloaded document has no "paths" object.');
  }
  if (Object.keys(paths).length === 0) {
    throw new SpecError('The downloaded document describes no paths at all.');
  }
  if (extractOperations(spec).length === 0) {
    throw new SpecError('The downloaded document contains no usable operations.');
  }

  return spec;
}

export async function fetchSpec(url: string, fetchImpl: FetchLike = globalThis.fetch): Promise<OpenApiSpec> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'informer-mcp' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new SpecError(`Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!response.ok) throw new SpecError(`${url} returned HTTP ${response.status}.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch (cause) {
    throw new SpecError(`${url} did not return JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return validateSpec(parsed);
}

export function readSpecCache(path: string): CachedSpec | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8')) as CachedSpec;
    validateSpec(cached.spec);
    return cached;
  } catch {
    // A damaged cache is not an error: fall back to the bundled document.
    return undefined;
  }
}

export async function writeSpecCache(path: string, spec: OpenApiSpec, url: string, now: string): Promise<CachedSpec> {
  const cached: CachedSpec = { spec, url, fetchedAt: now };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cached)}\n`);
  return cached;
}

/** The document the server starts from: a valid cache, otherwise the bundled copy. */
export function loadActiveSpec(env: NodeJS.ProcessEnv = process.env): ActiveSpec {
  const cached = readSpecCache(specCachePath(env));
  if (cached) return { spec: cached.spec, source: 'cache', fetchedAt: cached.fetchedAt };
  return { spec: loadSpec(), source: 'bundled' };
}

/** True when the cache is missing or older than the configured maximum age. */
export function cacheIsStale(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
  const maxAge = specMaxAgeHours(env);
  if (maxAge === 0) return false;

  const cached = readSpecCache(specCachePath(env));
  if (!cached) return true;

  const age = now - Date.parse(cached.fetchedAt);
  return !Number.isFinite(age) || age > maxAge * 3_600_000;
}

/* -------------------------------------------------------------------------- */
/* Diffing                                                                    */
/* -------------------------------------------------------------------------- */

export interface ToolChange {
  tool: string;
  endpoint: string;
  /** Short, human-readable notes such as "new required argument: project_id". */
  notes: string[];
}

export interface SpecDiff {
  added: { tool: string; endpoint: string }[];
  removed: { tool: string; endpoint: string }[];
  changed: ToolChange[];
  unchanged: number;
}

function argumentNames(operation: Operation): string[] {
  return Object.keys((operation.inputSchema.properties as Record<string, unknown>) ?? {});
}

function requiredNames(operation: Operation): string[] {
  return ((operation.inputSchema.required as string[] | undefined) ?? []).slice();
}

const DEFS_PREFIX = '#/$defs/';

/** Follows one `$ref` hop into the operation's own `$defs`. */
function deref(schema: unknown, defs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object') return undefined;

  const node = schema as Record<string, unknown>;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith(DEFS_PREFIX)) {
    return defs?.[ref.slice(DEFS_PREFIX.length)] as Record<string, unknown> | undefined;
  }
  return node;
}

/**
 * The fields a request body demands. Bodies are advertised as a `$ref` into
 * `$defs`, and some of them are a `oneOf` over variants, so both are followed.
 */
function bodyRequired(operation: Operation): string[] {
  const defs = operation.inputSchema.$defs as Record<string, unknown> | undefined;
  const body = deref((operation.inputSchema.properties as Record<string, unknown> | undefined)?.body, defs);
  if (!body) return [];

  const branches = [...((body.oneOf as unknown[]) ?? []), ...((body.allOf as unknown[]) ?? [])];
  const nested = branches.flatMap((branch) => ((deref(branch, defs)?.required as string[] | undefined) ?? []));

  return [...new Set([...((body.required as string[] | undefined) ?? []), ...nested])];
}

function missing(before: string[], after: string[]): string[] {
  return before.filter((entry) => !after.includes(entry));
}

/** Compares two operation sets and describes what a client would notice. */
export function diffOperations(before: Operation[], after: Operation[]): SpecDiff {
  const previous = new Map(before.map((operation) => [operation.toolName, operation]));
  const next = new Map(after.map((operation) => [operation.toolName, operation]));

  const diff: SpecDiff = { added: [], removed: [], changed: [], unchanged: 0 };

  for (const [tool, operation] of next) {
    const endpoint = `${operation.method.toUpperCase()} ${operation.path}`;
    const old = previous.get(tool);

    if (!old) {
      diff.added.push({ tool, endpoint });
      continue;
    }

    if (JSON.stringify(old.inputSchema) === JSON.stringify(operation.inputSchema)) {
      diff.unchanged += 1;
      continue;
    }

    const notes: string[] = [];
    const addedArgs = missing(argumentNames(operation), argumentNames(old));
    const removedArgs = missing(argumentNames(old), argumentNames(operation));
    const nowRequired = missing(requiredNames(operation), requiredNames(old));
    const noLongerRequired = missing(requiredNames(old), requiredNames(operation));
    const bodyNowRequired = missing(bodyRequired(operation), bodyRequired(old));
    const bodyNoLongerRequired = missing(bodyRequired(old), bodyRequired(operation));

    if (addedArgs.length) notes.push(`new argument(s): ${addedArgs.join(', ')}`);
    if (removedArgs.length) notes.push(`argument(s) gone: ${removedArgs.join(', ')}`);
    if (nowRequired.length) notes.push(`now required: ${nowRequired.join(', ')}`);
    if (noLongerRequired.length) notes.push(`no longer required: ${noLongerRequired.join(', ')}`);
    if (bodyNowRequired.length) notes.push(`body now requires: ${bodyNowRequired.join(', ')}`);
    if (bodyNoLongerRequired.length) notes.push(`body no longer requires: ${bodyNoLongerRequired.join(', ')}`);
    if (notes.length === 0) notes.push('schema details changed');

    diff.changed.push({ tool, endpoint, notes });
  }

  for (const [tool, operation] of previous) {
    if (!next.has(tool)) diff.removed.push({ tool, endpoint: `${operation.method.toUpperCase()} ${operation.path}` });
  }

  return diff;
}

export function diffIsEmpty(diff: SpecDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** One line for the stderr log. */
export function summariseDiff(diff: SpecDiff): string {
  if (diffIsEmpty(diff)) return 'no changes';
  return `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`;
}
