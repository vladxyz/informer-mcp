/**
 * Turns the vendored InformerOnline OpenAPI document into MCP tool definitions.
 *
 * The spec is the single source of truth: refreshing `openapi/api-docs.json`
 * (`npm run update-spec`) is all that is needed to pick up new endpoints.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

export type JsonObject = Record<string, unknown>;

export interface ParamSpec {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: JsonObject;
}

export interface Operation {
  /** MCP tool name, e.g. `list_sales_invoices`. */
  toolName: string;
  method: HttpMethod;
  /** Templated path relative to the server URL, e.g. `/invoices/sales/{id}`. */
  path: string;
  tag: string;
  summary: string;
  description: string;
  params: ParamSpec[];
  /** True when the endpoint changes state (anything other than GET). */
  mutating: boolean;
  /**
   * Set when the 200 response carries a base64 payload (`pdf` or `file`);
   * such tools accept an extra `save_path` argument.
   */
  binaryField?: 'pdf' | 'file';
  /** JSON Schema advertised to the MCP client. */
  inputSchema: JsonObject;
}

export interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, JsonObject> };
}

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'delete'];

const VERBS: Record<HttpMethod, string> = { get: 'get', post: 'create', put: 'update', delete: 'delete' };

const DEFAULT_SPEC_URL = new URL('../openapi/api-docs.json', import.meta.url);

/** Reads the vendored OpenAPI document (or another file, for tests). */
export function loadSpec(specPath: string = fileURLToPath(DEFAULT_SPEC_URL)): OpenApiSpec {
  return JSON.parse(readFileSync(specPath, 'utf8')) as OpenApiSpec;
}

/* -------------------------------------------------------------------------- */
/* Tool naming                                                                */
/* -------------------------------------------------------------------------- */

interface Resource {
  /** Longest matching prefix wins. */
  prefix: string;
  singular: string;
  plural: string;
  /** A resource without a collection endpoint, e.g. `/administration`. */
  singleton?: boolean;
}

const RESOURCES: Resource[] = [
  { prefix: '/administration', singular: 'administration', plural: 'administration', singleton: true },
  { prefix: '/relations', singular: 'relation', plural: 'relations' },
  { prefix: '/contact', singular: 'contact', plural: 'contacts' },
  { prefix: '/invoices/sales', singular: 'sales_invoice', plural: 'sales_invoices' },
  { prefix: '/invoices/purchase', singular: 'purchase_invoice', plural: 'purchase_invoices' },
  { prefix: '/invoices/recurring', singular: 'recurring_invoice', plural: 'recurring_invoices' },
  { prefix: '/orders/sales', singular: 'sales_order', plural: 'sales_orders' },
  { prefix: '/quotations', singular: 'quotation', plural: 'quotations' },
  { prefix: '/salesbook', singular: 'salesbook_invoice', plural: 'salesbook_invoices' },
  { prefix: '/payment-conditions', singular: 'payment_condition', plural: 'payment_conditions' },
  { prefix: '/templates', singular: 'template', plural: 'templates' },
  { prefix: '/vat', singular: 'vat_option', plural: 'vat_options' },
  { prefix: '/ledgers', singular: 'ledger', plural: 'ledgers' },
  { prefix: '/costs', singular: 'cost_centre', plural: 'cost_centres' },
  { prefix: '/currencies', singular: 'currency', plural: 'currencies' },
  { prefix: '/journals', singular: 'journal', plural: 'journals' },
  { prefix: '/subscription-types', singular: 'subscription_type', plural: 'subscription_types' },
  { prefix: '/attachments', singular: 'attachment', plural: 'attachments' },
  { prefix: '/products', singular: 'product', plural: 'products' },
  { prefix: '/receipts', singular: 'receipt', plural: 'receipts' },
  { prefix: '/memorandum', singular: 'memorandum_entry', plural: 'memorandum_entries' },
  { prefix: '/reports/balance', singular: 'balance_report', plural: 'balance_reports', singleton: true },
  {
    prefix: '/reports/column-balance',
    singular: 'column_balance_report',
    plural: 'column_balance_reports',
    singleton: true,
  },
];

function slug(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function matchResource(path: string): Resource | undefined {
  let best: Resource | undefined;
  for (const resource of RESOURCES) {
    const isPrefix = path === resource.prefix || path.startsWith(`${resource.prefix}/`);
    if (isPrefix && (!best || resource.prefix.length > best.prefix.length)) best = resource;
  }
  return best;
}

/**
 * Derives a stable, readable tool name from the HTTP method and path.
 * Unknown paths fall back to `<verb>_<path slug>`, so refreshing the spec with
 * new endpoints still yields usable tools.
 */
export function toolNameFor(method: HttpMethod, path: string): string {
  const resource = matchResource(path);
  if (!resource) return `${VERBS[method]}_${slug(path)}`;

  const rest = path.slice(resource.prefix.length);
  const { singular, plural } = resource;

  switch (`${method} ${rest}`) {
    case 'get ':
      return resource.singleton ? `get_${singular}` : `list_${plural}`;
    case 'post ':
      return `create_${singular}`;
    case 'get /{id}':
      return `get_${singular}`;
    case 'put /{id}':
      return `update_${singular}`;
    case 'delete /{id}':
      return `delete_${singular}`;
    case 'get /options':
      return `get_${singular}_options`;
    case 'get /pdf/{id}':
      return `get_${singular}_pdf`;
    case 'post /send/{id}':
      return `send_${singular}`;
    case 'post /{id}/attachments':
      return `upload_${singular}_attachment`;
    case 'get /{id}/attachments/{attachment_id}':
      return `download_${singular}_attachment`;
    case 'delete /{id}/attachments/{attachment_id}':
      return `delete_${singular}_attachment`;
    default: {
      const suffix = slug(rest);
      return suffix ? `${VERBS[method]}_${singular}_${suffix}` : `${VERBS[method]}_${singular}`;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Schema conversion                                                          */
/* -------------------------------------------------------------------------- */

const REF_PREFIX = '#/components/schemas/';

/**
 * Rewrites an OpenAPI 3.0 schema into plain JSON Schema: component refs move to
 * `#/$defs/...` and `nullable: true` becomes a union with `null`. Referenced
 * component names are collected into `refs`.
 */
function convertSchema(node: unknown, refs: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => convertSchema(item, refs));
  if (node === null || typeof node !== 'object') return node;

  const source = node as JsonObject;
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === 'nullable') continue;
    if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
      const name = value.slice(REF_PREFIX.length);
      refs.add(name);
      out.$ref = `#/$defs/${name}`;
      continue;
    }
    out[key] = convertSchema(value, refs);
  }

  if (source.nullable === true) {
    if (typeof out.type === 'string') {
      out.type = [out.type, 'null'];
    } else if (typeof out.$ref === 'string') {
      const ref = out.$ref;
      delete out.$ref;
      out.anyOf = [{ $ref: ref }, { type: 'null' }];
    }
  }

  return out;
}

/** Resolves the transitive closure of the component schemas used by `refs`. */
function buildDefs(spec: OpenApiSpec, refs: Set<string>): JsonObject | undefined {
  const schemas = spec.components?.schemas ?? {};
  const defs: JsonObject = {};
  const queue = [...refs];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);

    const schema = schemas[name];
    if (!schema) continue;

    const nested = new Set<string>();
    defs[name] = convertSchema(schema, nested) as JsonObject;
    for (const child of nested) if (!seen.has(child)) queue.push(child);
  }

  return Object.keys(defs).length > 0 ? defs : undefined;
}

/* -------------------------------------------------------------------------- */
/* Operation extraction                                                       */
/* -------------------------------------------------------------------------- */

function jsonSchemaOf(container: unknown): JsonObject | undefined {
  const content = (container as { content?: Record<string, { schema?: JsonObject }> } | undefined)?.content;
  return content?.['application/json']?.schema;
}

function detectBinaryField(operation: JsonObject): 'pdf' | 'file' | undefined {
  const responses = operation.responses as Record<string, unknown> | undefined;
  const properties = jsonSchemaOf(responses?.['200'])?.properties as JsonObject | undefined;
  if (!properties) return undefined;
  if ('pdf' in properties) return 'pdf';
  if ('file' in properties && 'filename' in properties) return 'file';
  return undefined;
}

function describe(operation: JsonObject, tag: string, path: string, method: HttpMethod): string {
  const summary = typeof operation.summary === 'string' ? operation.summary : '';
  const detail = typeof operation.description === 'string' ? operation.description : '';
  const head = summary && !summary.endsWith('.') ? `${summary}.` : summary;
  return [head, detail, `[${tag}] ${method.toUpperCase()} ${path}`].filter((part) => part.length > 0).join('\n\n');
}

/** Reads every GET/POST/PUT/DELETE operation out of the spec. */
export function extractOperations(spec: OpenApiSpec): Operation[] {
  const operations: Operation[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const raw = pathItem[method];
      if (!raw || typeof raw !== 'object') continue;
      const operation = raw as JsonObject;

      const refs = new Set<string>();
      const tag = (operation.tags as string[] | undefined)?.[0] ?? 'Other';
      const params: ParamSpec[] = [];
      const properties: JsonObject = {};
      const required: string[] = [];

      for (const entry of (operation.parameters as JsonObject[] | undefined) ?? []) {
        const location = entry.in;
        if (location !== 'path' && location !== 'query') continue;

        const name = String(entry.name);
        const schema = convertSchema(entry.schema ?? { type: 'string' }, refs) as JsonObject;
        if (typeof entry.description === 'string' && schema.description === undefined) {
          schema.description = entry.description;
        }
        const isRequired = entry.required === true || location === 'path';

        params.push({
          name,
          in: location,
          required: isRequired,
          description: typeof schema.description === 'string' ? schema.description : undefined,
          schema,
        });
        properties[name] = schema;
        if (isRequired) required.push(name);
      }

      const bodySchema = jsonSchemaOf(operation.requestBody);
      if (bodySchema) {
        properties.body = convertSchema(bodySchema, refs) as JsonObject;
        if ((operation.requestBody as JsonObject).required === true) required.push('body');
      }

      const binaryField = detectBinaryField(operation);
      if (binaryField) {
        properties.save_path = {
          type: 'string',
          description:
            'Optional absolute file path to write the decoded file to. When omitted the file is returned inline as a base64 resource.',
        };
      }

      const inputSchema: JsonObject = { type: 'object', properties, additionalProperties: false };
      if (required.length > 0) inputSchema.required = required;
      const defs = buildDefs(spec, refs);
      if (defs) inputSchema.$defs = defs;

      operations.push({
        toolName: toolNameFor(method, path),
        method,
        path,
        tag,
        summary: typeof operation.summary === 'string' ? operation.summary : path,
        description: describe(operation, tag, path, method),
        params,
        mutating: method !== 'get',
        ...(binaryField ? { binaryField } : {}),
        inputSchema,
      });
    }
  }

  return operations;
}
