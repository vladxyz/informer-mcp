/**
 * A tiny local web UI for entering Informer credentials.
 *
 * Typing API keys into a shell profile is the worst part of installing an MCP
 * server, so `informer-mcp setup` opens a page on 127.0.0.1 instead, verifies
 * each key against the API, and writes the config file.
 *
 * The page is reachable only from this machine and only with a random token
 * generated per run, so another site in the same browser cannot post to it.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';

import { InformerClient, type FetchLike } from './client.js';
import {
  ConfigError,
  configFilePath,
  loadAdministrations,
  loadConfig,
  parseAdministrationsInput,
  type Administration,
  type Config,
} from './config.js';
import { setupPage, type SetupRow } from './setup-page.js';

const MAX_BODY_BYTES = 256 * 1024;

export interface SetupRowInput {
  alias?: string;
  label?: string;
  apiKey?: string;
  securityCode?: string;
  mode?: string;
  /** Keep the credentials already on disk for this alias. */
  keepExisting?: boolean;
}

export interface VerifyResult {
  alias: string;
  ok: boolean;
  company_name?: string;
  error?: string;
}

export interface SetupServer {
  url: string;
  port: number;
  /** Resolves once credentials have been saved. */
  saved: Promise<string>;
  close(): Promise<void>;
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /** 0 picks a free port. */
  port?: number;
  fetchImpl?: FetchLike;
  /** Shown on the page after saving. */
  savedHint?: string;
}

export const RESTART_HINT = 'Restart your MCP client to pick it up.';
export const LIVE_HINT = 'Your MCP client has already picked it up — no restart needed.';

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(payload);
}

/** Rejects anything that is not a loopback Host, which blocks DNS rebinding. */
function hostIsLocal(request: IncomingMessage): boolean {
  const host = (request.headers.host ?? '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** The aliases already on disk, without their secrets. */
export function existingRows(env: NodeJS.ProcessEnv): SetupRow[] {
  let administrations: Record<string, Administration> = {};
  try {
    administrations = loadAdministrations(env);
  } catch {
    // A broken config file should not stop someone from fixing it here.
    return [];
  }

  return Object.values(administrations).map((administration) => ({
    alias: administration.alias,
    ...(administration.label ? { label: administration.label } : {}),
    mode: administration.mode ?? 'read-write',
    hasCredentials: true,
  }));
}

/** Merges the submitted rows with the credentials already on disk. */
export function buildAdministrations(
  rows: SetupRowInput[],
  existing: Record<string, Administration>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const row of rows) {
    const alias = (row.alias ?? '').trim();
    if (!alias) continue;

    const previous = existing[alias];
    const apiKey = (row.apiKey ?? '').trim() || (row.keepExisting ? previous?.apiKey : undefined);
    const securityCode = (row.securityCode ?? '').trim() || (row.keepExisting ? previous?.securityCode : undefined);

    if (!apiKey || !securityCode) {
      throw new ConfigError(`Administration "${alias}" is missing an API key or security code.`);
    }

    out[alias] = {
      ...(row.label?.trim() ? { label: row.label.trim() } : {}),
      api_key: apiKey,
      security_code: securityCode,
      ...(row.mode === 'read-only' ? { mode: 'read-only' } : {}),
    };
  }

  if (Object.keys(out).length === 0) throw new ConfigError('Add at least one administration.');
  return out;
}

/**
 * Transport settings only. A broken config file must not stop the setup UI from
 * verifying the credentials that are about to replace it.
 */
function baseConfig(env: NodeJS.ProcessEnv): Config {
  try {
    return loadConfig(env);
  } catch {
    return {
      administrations: {},
      baseUrl: (env.INFORMER_BASE_URL?.trim() || 'https://api.informer.eu/v2').replace(/\/+$/, ''),
      readOnly: false,
      include: [],
      exclude: [],
      timeoutMs: 30_000,
      maxRetries: 0,
      maxResponseChars: 100_000,
      fanoutConcurrency: 4,
    };
  }
}

/** Calls GET /administration once per entry, so a typo is caught before it is saved. */
async function verifyAdministrations(
  administrations: Record<string, Administration>,
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
): Promise<VerifyResult[]> {
  const config = { ...baseConfig(env), administrations, readOnly: false, maxRetries: 0 };
  const client = new InformerClient(config, fetchImpl);

  return Promise.all(
    Object.keys(administrations).map(async (alias): Promise<VerifyResult> => {
      try {
        const details = (await client.request({ method: 'get', path: '/administration', administration: alias })) as
          | { company_name?: string }
          | undefined;
        return { alias, ok: true, ...(details?.company_name ? { company_name: details.company_name } : {}) };
      } catch (error) {
        return { alias, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

async function writeConfigFile(path: string, administrations: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ administrations }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

/** Starts the setup UI on 127.0.0.1. The caller decides whether to open a browser. */
export function startSetupServer(options: SetupOptions = {}): Promise<SetupServer> {
  const env = options.env ?? process.env;
  const token = randomBytes(24).toString('base64url');
  const path = configFilePath(env);

  let resolveSaved: (value: string) => void;
  const saved = new Promise<string>((resolve) => {
    resolveSaved = resolve;
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!hostIsLocal(request)) return json(response, 403, { ok: false, error: 'Only reachable from this machine.' });

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.get('t') !== token) {
        return json(response, 403, { ok: false, error: 'Missing or wrong setup token. Reopen the printed URL.' });
      }
      const page = setupPage(token, path, existingRows(env), options.savedHint ?? RESTART_HINT);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void response.end(page);
    }

    if (request.method === 'POST' && url.pathname === '/save') {
      if (request.headers['x-informer-token'] !== token) {
        return json(response, 403, { ok: false, error: 'Missing or wrong setup token.' });
      }

      try {
        const body = (await readBody(request)) as { administrations?: SetupRowInput[]; verify?: boolean };
        const rows = Array.isArray(body.administrations) ? body.administrations : [];

        let previous: Record<string, Administration> = {};
        try {
          previous = loadAdministrations(env);
        } catch {
          previous = {};
        }

        const raw = buildAdministrations(rows, previous);
        const parsed = parseAdministrationsInput({ administrations: raw }, 'this form');

        let results: VerifyResult[] = [];
        if (body.verify !== false) {
          results = await verifyAdministrations(parsed, env, options.fetchImpl);
          const failed = results.filter((result) => !result.ok);
          if (failed.length > 0) {
            return json(response, 200, {
              ok: false,
              error: `Could not reach ${failed.map((f) => f.alias).join(', ')}. Fix the credentials, or tick "Save without verifying".`,
              results,
            });
          }
        }

        await writeConfigFile(path, raw);
        json(response, 200, { ok: true, path, results });
        resolveSaved(path);
        return;
      } catch (error) {
        return json(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return json(response, 404, { ok: false, error: 'Not found.' });
  };

  const server: Server = createHttpServer((request, response) => {
    void handle(request, response).catch(() => json(response, 500, { ok: false, error: 'Internal error.' }));
  });

  return new Promise<SetupServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/?t=${token}`,
        port,
        saved,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/**
 * Best-effort browser launch; the URL is always printed as a fallback, and
 * `INFORMER_OPEN_BROWSER=false` skips it for headless or remote machines.
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.INFORMER_OPEN_BROWSER?.trim().toLowerCase() === 'false') return;

  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    spawn(command as string, args as string[], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Headless machine, or no handler registered — the printed URL still works.
  }
}
