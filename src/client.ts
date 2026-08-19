/**
 * Thin HTTP client for the InformerOnline v2 API.
 *
 * Credentials are resolved per request, because one server can serve several
 * client administrations and Informer scopes an API key to exactly one of them.
 */

import type { Administration, Config } from './config.js';
import { SETUP_TOOL } from './names.js';
import { NO_CREDENTIALS_MESSAGE, administrationAliases, hasCredentials } from './config.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method: 'get' | 'post' | 'put' | 'delete';
  /** Templated path such as `/invoices/sales/{id}`. */
  path: string;
  /** Alias of the administration to act on. Optional when only one is configured. */
  administration?: string;
  pathParams?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

export class InformerApiError extends Error {
  override readonly name = 'InformerApiError';

  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class InformerConfigError extends Error {
  override readonly name = 'InformerConfigError';
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns `{ error: ... , response_code: n }` envelopes into a single line. */
export function formatApiError(status: number, body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error;

  if (typeof error === 'string') return `HTTP ${status}: ${error}`;
  if (Array.isArray(error)) return `HTTP ${status}: ${error.join('; ')}`;
  if (error && typeof error === 'object') {
    const fields = Object.entries(error as Record<string, unknown>)
      .map(([field, message]) => `${field}: ${String(message)}`)
      .join('; ');
    return `HTTP ${status}: ${fields}`;
  }
  if (typeof body === 'string' && body.trim().length > 0) return `HTTP ${status}: ${body.slice(0, 500)}`;
  return `HTTP ${status}`;
}

/** Fills `{placeholders}` in a path template; every placeholder must be supplied. */
export function buildPath(template: string, pathParams: Record<string, unknown> = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null || value === '') {
      throw new InformerConfigError(`Missing required path parameter "${name}" for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}

export function buildQuery(query: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

export class InformerClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {}

  /**
   * Picks the administration to act on. With a single configured administration
   * the argument is optional; with several it is required, so that a request can
   * never silently land in the wrong client's books.
   */
  resolveAdministration(alias?: string): Administration {
    if (!hasCredentials(this.config)) throw new InformerConfigError(NO_CREDENTIALS_MESSAGE);

    const aliases = administrationAliases(this.config);

    if (alias === undefined || alias === '') {
      if (aliases.length === 1) return this.config.administrations[aliases[0] as string] as Administration;
      throw new InformerConfigError(
        `This server is configured for ${aliases.length} administrations, so the "administration" argument is ` +
          `required. Choose one of: ${aliases.join(', ')}. Use list_administrations to see which company each alias is.`,
      );
    }

    const administration = this.config.administrations[alias];
    if (!administration) {
      throw new InformerConfigError(`Unknown administration "${alias}". Configured aliases: ${aliases.join(', ')}.`);
    }
    return administration;
  }

  async request(options: RequestOptions): Promise<unknown> {
    const administration = this.resolveAdministration(options.administration);

    const url = `${this.config.baseUrl}${buildPath(options.path, options.pathParams)}${buildQuery(options.query)}`;
    const headers: Record<string, string> = {
      Apikey: administration.apiKey,
      Securitycode: administration.securityCode,
      Accept: 'application/json',
      'User-Agent': 'informer-mcp',
    };

    const init: RequestInit = { method: options.method.toUpperCase(), headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(this.backoffMs(attempt, lastError));

      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
      } catch (cause) {
        lastError = cause;
        if (attempt === this.config.maxRetries) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new InformerApiError(`[${administration.alias}] Request to ${url} failed: ${reason}`, 0, undefined);
        }
        continue;
      }

      const payload = await this.readBody(response);

      if (response.ok) return payload;

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
        lastError = response;
        continue;
      }

      // A rejected key is the one failure with an obvious next step, so say it.
      const hint =
        response.status === 401 || response.status === 403
          ? ` — Informer rejected the credentials for "${administration.alias}". Call ${SETUP_TOOL} to correct the ` +
            'API key or security code; they may have been rotated or copied from another administration.'
          : '';

      throw new InformerApiError(
        `[${administration.alias}] ${formatApiError(response.status, payload)}${hint}`,
        response.status,
        payload,
      );
    }

    /* istanbul ignore next -- the loop always returns or throws */
    throw new InformerApiError('Request failed', 0, lastError);
  }

  private backoffMs(attempt: number, lastError: unknown): number {
    if (lastError instanceof Response) {
      const retryAfter = Number(lastError.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 30_000);
    }
    return Math.min(500 * 2 ** (attempt - 1), 8_000);
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
