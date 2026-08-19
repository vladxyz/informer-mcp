/**
 * Registers one MCP tool per InformerOnline API operation, plus a helper tool
 * that lists the configured client administrations.
 *
 * Read-only tools can be pointed at several administrations at once, so a
 * bookkeeper can ask one question across a whole client portfolio. Anything that
 * writes stays deliberately single-administration.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult, McpServer, RegisteredTool } from '@modelcontextprotocol/server';

import type { InformerClient } from './client.js';
import type { Config } from './config.js';
import {
  ALL_ADMINISTRATIONS,
  NO_CREDENTIALS_MESSAGE,
  accessMode,
  administrationAliases,
  hasCredentials,
  writableAliases,
} from './config.js';
import type { JsonObject, Operation } from './openapi.js';

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export { LIST_ADMINISTRATIONS_TOOL, SETUP_TOOL } from './names.js';

import { LIST_ADMINISTRATIONS_TOOL, SETUP_TOOL } from './names.js';

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Applies the access mode and the include/exclude allowlists.
 *
 * Write tools disappear entirely when nothing is writable; when only some
 * administrations are, the tools stay and their selector is narrowed instead.
 */
export function selectOperations(operations: Operation[], config: Config): Operation[] {
  const include = new Set(config.include.map(normalize));
  const exclude = new Set(config.exclude.map(normalize));
  const canWriteSomewhere = hasCredentials(config) ? writableAliases(config).length > 0 : !config.readOnly;

  return operations.filter((operation) => {
    if (operation.mutating && !canWriteSomewhere) return false;

    const keys = [normalize(operation.toolName), normalize(operation.tag)];
    if (include.size > 0 && !keys.some((key) => include.has(key))) return false;
    if (keys.some((key) => exclude.has(key))) return false;
    return true;
  });
}

/**
 * Whether an operation may be run against several administrations in one call.
 *
 * Writes are excluded because repeating them across clients is almost never what
 * was meant; file downloads are excluded because they resolve to a single file.
 */
export function supportsFanout(operation: Operation): boolean {
  return !operation.mutating && operation.binaryField === undefined;
}

/* -------------------------------------------------------------------------- */
/* The administration selector                                                */
/* -------------------------------------------------------------------------- */

function describeAliases(config: Config, aliases: string[]): string {
  return aliases
    .map((alias) => {
      const label = config.administrations[alias]?.label;
      return label ? `${alias} (${label})` : alias;
    })
    .join(', ');
}

export interface SelectorOptions {
  /** Whether the operation may target several administrations at once. */
  fanout?: boolean;
  /** Aliases this operation may target. Defaults to every configured one. */
  allowed?: string[];
}

/** Aliases an operation may run against, honouring per-client access modes. */
export function allowedAliases(operation: Operation, config: Config): string[] {
  return operation.mutating ? writableAliases(config) : administrationAliases(config);
}

/**
 * Adds the `administration` selector to an operation's input schema.
 *
 * With several administrations configured the argument is required: picking the
 * wrong client's books is the one mistake that must not happen silently. Read-only
 * operations also accept a list of aliases or `"all"`, and write operations only
 * offer the administrations that are configured as writable.
 */
export function withAdministration(inputSchema: JsonObject, config: Config, options: SelectorOptions = {}): JsonObject {
  const configured = administrationAliases(config);
  const aliases = options.allowed ?? configured;
  if (aliases.length === 0) return inputSchema;

  const labels = describeAliases(config, aliases);
  const many = configured.length > 1;
  const allowFanout = options.fanout === true && aliases.length > 1;
  const narrowed = aliases.length < configured.length;

  const single: JsonObject = { type: 'string', enum: allowFanout ? [...aliases, ALL_ADMINISTRATIONS] : aliases };

  const description = many
    ? 'The client administration to act on. Required, because this server serves several. ' +
      (narrowed ? `Writable: ${labels}.` : `Available: ${labels}.`) +
      (allowFanout
        ? ` Pass an array of aliases, or "${ALL_ADMINISTRATIONS}", to run the same query against several ` +
          'administrations at once; the result is then keyed by alias.'
        : '')
    : `The client administration to act on. Only one is configured: ${labels}.`;

  const selector: JsonObject = allowFanout
    ? {
        description,
        anyOf: [single, { type: 'array', items: { type: 'string', enum: aliases }, minItems: 1, uniqueItems: true }],
      }
    : { ...single, description };

  const required = [...((inputSchema.required as string[] | undefined) ?? [])];
  if (many) required.unshift('administration');

  return {
    ...inputSchema,
    properties: { administration: selector, ...(inputSchema.properties as JsonObject) },
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Expands the `administration` argument into the list of aliases to act on.
 *
 * Both guards are deliberately duplicated from the schema: a write must resolve
 * to exactly one administration, and never to one that is configured read-only.
 */
export function resolveTargets(value: unknown, config: Config, options: SelectorOptions = {}): string[] {
  const configured = administrationAliases(config);
  if (configured.length === 0) throw new Error(NO_CREDENTIALS_MESSAGE);

  const fanout = options.fanout !== false;
  const aliases = options.allowed ?? configured;
  if (aliases.length === 0) {
    throw new Error(
      'No administration is configured as writable, so this tool cannot run. Give the administration you want to ' +
        'change "mode": "read-write", or start the server with --read-write.',
    );
  }

  if (value === undefined || value === '') {
    if (configured.length === 1) return aliases;
    throw new Error(
      `This server is configured for ${configured.length} administrations, so the "administration" argument is ` +
        `required. Choose one of: ${aliases.join(', ')}` +
        (fanout ? `, pass a list, or "${ALL_ADMINISTRATIONS}".` : '.'),
    );
  }

  if (!fanout && (Array.isArray(value) || value === ALL_ADMINISTRATIONS)) {
    throw new Error(
      'This tool runs against exactly one administration, so "administration" must be a single alias. ' +
        `Allowed aliases: ${aliases.join(', ')}.`,
    );
  }

  const requested =
    value === ALL_ADMINISTRATIONS ? aliases : Array.isArray(value) ? value.map(String) : [String(value)];

  const rejected = requested.filter((alias) => !aliases.includes(alias));
  if (rejected.length > 0) {
    const readOnly = rejected.filter((alias) => configured.includes(alias));
    if (readOnly.length > 0) {
      throw new Error(
        `Administration(s) ${readOnly.join(', ')} are configured as read-only, so this tool cannot change them. ` +
          `Writable: ${aliases.join(', ')}.`,
      );
    }
    throw new Error(`Unknown administration(s): ${rejected.join(', ')}. Configured aliases: ${configured.join(', ')}.`);
  }
  if (requested.length === 0) throw new Error('The "administration" list is empty.');

  return [...new Set(requested)];
}

/* -------------------------------------------------------------------------- */
/* Result formatting                                                          */
/* -------------------------------------------------------------------------- */

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function errorResult(error: unknown): CallToolResult {
  return textResult(error instanceof Error ? error.message : String(error), true);
}

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n[truncated: ${omitted} more characters. Narrow the request with the "records"/"page" arguments or set INFORMER_MAX_RESPONSE_CHARS higher.]`;
}

/** Runs `task` over `items`, at most `limit` at a time, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

function mimeTypeFor(filename: string | undefined, binaryField: 'pdf' | 'file'): string {
  if (binaryField === 'pdf') return 'application/pdf';
  const extension = filename ? extname(filename).toLowerCase() : '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

/** Splits the flat tool arguments back into path params, query params and body. */
function splitArguments(
  operation: Operation,
  args: Record<string, unknown>,
): { pathParams: Record<string, unknown>; query: Record<string, unknown>; body: unknown; savePath?: string } {
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};

  for (const param of operation.params) {
    const value = args[param.name];
    if (value === undefined) continue;
    if (param.in === 'path') pathParams[param.name] = value;
    else query[param.name] = value;
  }

  return {
    pathParams,
    query,
    body: args.body,
    ...(typeof args.save_path === 'string' ? { savePath: args.save_path } : {}),
  };
}

async function handleBinary(
  operation: Operation,
  payload: unknown,
  savePath: string | undefined,
  uri: string,
): Promise<CallToolResult | undefined> {
  const field = operation.binaryField;
  if (!field) return undefined;

  const record = payload as Record<string, unknown> | undefined;
  const base64 = record?.[field];
  if (typeof base64 !== 'string' || base64.length === 0) return undefined;

  const filename = typeof record?.filename === 'string' ? record.filename : undefined;
  const mimeType = mimeTypeFor(filename, field);
  const bytes = Buffer.from(base64, 'base64');

  if (savePath) {
    const target = resolve(savePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return jsonResult({ saved_to: target, filename: filename ?? null, bytes: bytes.byteLength, mime_type: mimeType });
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ filename: filename ?? null, bytes: bytes.byteLength, mime_type: mimeType }, null, 2),
      },
      { type: 'resource', resource: { uri, mimeType, blob: base64 } },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Registers a tool that shows which administrations this server can reach, so
 * the alias -> company mapping can be verified before anything is booked.
 */
function registerAdministrationsTool(server: McpServer, client: InformerClient, config: Config): void {
  server.registerTool(
    LIST_ADMINISTRATIONS_TOOL,
    {
      title: 'List configured administrations',
      description:
        'List the client administrations this server is configured for, with the alias to pass as the ' +
        '"administration" argument of every other tool, and whether each one may be written to. Set "verify" to also ' +
        'fetch each company name from the API, which confirms the credentials work and that each alias points at the ' +
        `company you expect. To change any of it — add a client, replace a key, switch one to read-only — use ${SETUP_TOOL}.`,
      inputSchema: fromJsonSchema<{ verify?: boolean }>({
        type: 'object',
        properties: {
          verify: {
            type: 'boolean',
            description: 'Call the API once per administration to resolve the real company name. Defaults to false.',
          },
        },
        additionalProperties: false,
      }),
      annotations: {
        title: 'List configured administrations',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      const aliases = administrationAliases(config);
      if (aliases.length === 0) return errorResult(new Error(NO_CREDENTIALS_MESSAGE));

      const entries = await mapWithConcurrency(aliases, config.fanoutConcurrency, async (alias) => {
        const base = { alias, label: config.administrations[alias]?.label ?? null, mode: accessMode(config, alias) };
        if (args?.verify !== true) return base;

        try {
          const details = (await client.request({ method: 'get', path: '/administration', administration: alias })) as
            | Record<string, unknown>
            | undefined;
          return {
            ...base,
            company_name: details?.company_name ?? null,
            city: details?.city ?? null,
            coc: details?.coc ?? null,
            vat: details?.vat ?? null,
          };
        } catch (error) {
          return { ...base, error: error instanceof Error ? error.message : String(error) };
        }
      });

      const writable = writableAliases(config);
      const failed = entries.filter((entry) => 'error' in entry).map((entry) => entry.alias);

      return jsonResult({
        administrations: entries,
        administration_argument: aliases.length > 1 ? 'required' : 'optional',
        writable: writable.length > 0 ? writable : 'none — this server is read-only',
        fan_out: aliases.length > 1 ? 'Read-only tools accept a list of aliases or "all".' : undefined,
        fix:
          failed.length > 0
            ? `${failed.join(', ')} could not be reached. Call ${SETUP_TOOL} to open the configuration page and ` +
              'correct the credentials.'
            : undefined,
      });
    },
  );
}

export interface RegisterToolsOptions {
  server: McpServer;
  client: InformerClient;
  config: Config;
  operations: Operation[];
}

export interface SyncResult {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * The live tool surface. `sync` makes the registered tools match a new set of
 * operations, which is how a refreshed OpenAPI document reaches a client that is
 * already connected.
 */
export interface ToolRegistry {
  toolNames(): string[];
  operations(): Operation[];
  /**
   * Makes the registered tools match `operations` under the current config, and
   * emits at most one tools/list_changed for the whole batch.
   */
  sync(operations: Operation[]): SyncResult;
}

/** Everything the SDK needs to advertise one operation, derived fresh each time. */
function toolDefinition(operation: Operation, config: Config) {
  const fanout = supportsFanout(operation);
  const allowed = allowedAliases(operation, config);

  return {
    selector: { fanout, allowed },
    title: operation.summary,
    description:
      operation.description +
      (fanout && allowed.length > 1
        ? '\n\nAccepts several administrations at once: pass a list of aliases or "all" as "administration".'
        : ''),
    schema: fromJsonSchema<Record<string, unknown>>(withAdministration(operation.inputSchema, config, { fanout, allowed })),
    annotations: {
      title: operation.summary,
      readOnlyHint: !operation.mutating,
      destructiveHint: operation.method === 'delete',
      idempotentHint: operation.method === 'get' || operation.method === 'put' || operation.method === 'delete',
      openWorldHint: true,
    },
  };
}

/**
 * Registers the API operations and returns a handle that can re-sync them.
 *
 * Handlers read the operation out of a mutable slot, so a refreshed spec swaps
 * the behaviour of an existing tool without re-creating its closure.
 */
export function registerTools({ server, client, config, operations }: RegisterToolsOptions): ToolRegistry {
  registerAdministrationsTool(server, client, config);

  interface Entry {
    operation: Operation;
    registered: RegisteredTool;
    /** The advertised schema, so a re-sync only touches tools that really changed. */
    advertised: string;
  }

  const entries = new Map<string, Entry>();

  const makeHandler = (entry: { operation: Operation }) =>
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const operation = entry.operation;
      const { pathParams, query, body, savePath } = splitArguments(operation, args ?? {});

      let targets: string[];
      try {
        targets = resolveTargets(args?.administration, config, {
          fanout: supportsFanout(operation),
          allowed: allowedAliases(operation, config),
        });
      } catch (error) {
        return errorResult(error);
      }

      const call = (administration: string) =>
        client.request({
          method: operation.method,
          path: operation.path,
          administration,
          pathParams,
          query,
          ...(body === undefined ? {} : { body }),
        });

      // One administration: return its payload unwrapped, exactly as the API sent it.
      if (targets.length === 1) {
        const administration = targets[0] as string;
        try {
          const payload = await call(administration);
          const uri = `informer://${administration}/${operation.path.replace(/^\//, '')}`;
          const binary = await handleBinary(operation, payload, savePath, uri);
          if (binary) return binary;

          if (payload === undefined) return textResult('OK (empty response)');
          return textResult(truncate(JSON.stringify(payload, null, 2), config.maxResponseChars));
        } catch (error) {
          return errorResult(error);
        }
      }

      // Several administrations: query them concurrently and key the result by
      // alias. Each one gets an equal slice of the response budget, so a single
      // large client cannot crowd the others out, and a failure stays local.
      const budget = Math.floor(config.maxResponseChars / targets.length);

      const results = await mapWithConcurrency(targets, config.fanoutConcurrency, async (administration) => {
        try {
          const payload = await call(administration);
          if (payload === undefined) return [administration, 'OK (empty response)'] as const;

          const text = JSON.stringify(payload);
          if (budget <= 0 || text.length <= budget) return [administration, payload] as const;

          return [
            administration,
            {
              truncated: true,
              note:
                `The response was ${text.length} characters and this administration's share of the budget is ` +
                `${budget}. Query fewer administrations at once, narrow the request with "records"/"page", or ` +
                'raise INFORMER_MAX_RESPONSE_CHARS.',
              partial: text.slice(0, budget),
            },
          ] as const;
        } catch (error) {
          return [administration, { error: error instanceof Error ? error.message : String(error) }] as const;
        }
      });

      const keyed: Record<string, unknown> = {};
      for (const [alias, value] of results) keyed[alias] = value;

      return jsonResult({ administrations: targets, results: keyed });
    };

  function syncOnce(next: Operation[]): SyncResult {
    const desired = new Map(selectOperations(next, config).map((operation) => [operation.toolName, operation]));
    const result: SyncResult = { added: [], removed: [], changed: [] };

    for (const [name, entry] of entries) {
      if (desired.has(name)) continue;
      entry.registered.remove();
      entries.delete(name);
      result.removed.push(name);
    }

    for (const [name, operation] of desired) {
      const existing = entries.get(name);
      const definition = toolDefinition(operation, config);
      // Compare what the client would see, not the operation: a changed config
      // rewrites the administration selector while the operation stays the same.
      const advertised = JSON.stringify(withAdministration(operation.inputSchema, config, definition.selector));

      if (!existing) {
        const entry = { operation, advertised } as Entry;
        entry.registered = server.registerTool(
          name,
          {
            title: definition.title,
            description: definition.description,
            inputSchema: definition.schema,
            annotations: definition.annotations,
          },
          makeHandler(entry),
        );
        entries.set(name, entry);
        result.added.push(name);
        continue;
      }

      if (existing.advertised === advertised) {
        existing.operation = operation;
        continue;
      }

      existing.operation = operation;
      existing.advertised = advertised;
      existing.registered.update({
        title: definition.title,
        description: definition.description,
        paramsSchema: definition.schema,
        annotations: definition.annotations,
      });
      result.changed.push(name);
    }

    return result;
  }

  /**
   * Registering, updating and removing each emit their own list-changed
   * notification. Re-advertising seventy tools would send seventy of them, so
   * the batch is muted and a single notification is sent afterwards.
   */
  function sync(next: Operation[]): SyncResult {
    const notify = server.sendToolListChanged.bind(server);
    const mutable = server as unknown as { sendToolListChanged: () => void };
    let touched = false;

    mutable.sendToolListChanged = () => {
      touched = true;
    };

    let result: SyncResult;
    try {
      result = syncOnce(next);
    } finally {
      mutable.sendToolListChanged = notify;
    }

    if (touched) notify();
    return result;
  }

  sync(operations);

  return {
    toolNames: () => [LIST_ADMINISTRATIONS_TOOL, ...entries.keys()],
    operations: () => [...entries.values()].map((entry) => entry.operation),
    sync,
  };
}
