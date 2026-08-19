import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { extractOperations, loadSpec, type JsonObject } from '../src/openapi.js';
import { selectOperations, withAdministration } from '../src/tools.js';

const EMPTY = fileURLToPath(new URL('./fixtures/empty.json', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/administrations.json', import.meta.url));

const operations = extractOperations(loadSpec());
const names = (env: NodeJS.ProcessEnv) =>
  selectOperations(operations, loadConfig({ INFORMER_CONFIG_FILE: EMPTY, ...env })).map((o) => o.toolName);

const listRelations = operations.find((operation) => operation.toolName === 'list_relations')!;
const getRelation = operations.find((operation) => operation.toolName === 'get_relation')!;

describe('selectOperations', () => {
  it('exposes everything by default', () => {
    expect(names({})).toHaveLength(operations.length);
  });

  it('drops mutating operations in read-only mode', () => {
    const selected = names({ INFORMER_READ_ONLY: 'true' });
    expect(selected).toContain('list_relations');
    expect(selected).not.toContain('create_relation');
    expect(selected).not.toContain('delete_sales_invoice_attachment');
  });

  it('filters by OpenAPI tag', () => {
    const selected = names({ INFORMER_TOOLS: 'Relations, Sales Invoices' });
    expect(selected).toContain('list_relations');
    expect(selected).toContain('create_sales_invoice');
    expect(selected).not.toContain('list_products');
  });

  it('filters by tool name', () => {
    expect(names({ INFORMER_TOOLS: 'list_relations,get_relation' }).sort()).toEqual(['get_relation', 'list_relations']);
  });

  it('applies the denylist after the allowlist', () => {
    const selected = names({ INFORMER_TOOLS: 'Relations', INFORMER_EXCLUDE_TOOLS: 'update_relation' });
    expect(selected).toContain('list_relations');
    expect(selected).not.toContain('update_relation');
  });

  it('combines read-only mode with a tag filter', () => {
    const selected = names({ INFORMER_READ_ONLY: '1', INFORMER_TOOLS: 'Relations' });
    expect(selected).toEqual(['get_relation', 'list_relations']);
  });
});

describe('withAdministration', () => {
  it('adds nothing when no administration is configured', () => {
    const schema = withAdministration(listRelations.inputSchema, loadConfig({ INFORMER_CONFIG_FILE: EMPTY }));
    expect((schema.properties as JsonObject).administration).toBeUndefined();
  });

  it('offers an optional selector when a single administration is configured', () => {
    const config = loadConfig({ INFORMER_CONFIG_FILE: EMPTY, INFORMER_API_KEY: 'k', INFORMER_SECURITY_CODE: 'c' });
    const schema = withAdministration(listRelations.inputSchema, config);
    const selector = (schema.properties as JsonObject).administration as JsonObject;

    expect(selector.enum).toEqual(['default']);
    expect(schema.required).toBeUndefined();
  });

  it('requires the selector when several administrations are configured', () => {
    const schema = withAdministration(listRelations.inputSchema, loadConfig({ INFORMER_CONFIG_FILE: MULTI }));
    const selector = (schema.properties as JsonObject).administration as JsonObject;

    expect(selector.enum).toEqual(['acme', 'bakkerij']);
    expect(selector.description).toContain('acme (ACME BV)');
    expect(schema.required).toEqual(['administration']);
  });

  it('keeps the operation’s own required arguments', () => {
    const schema = withAdministration(getRelation.inputSchema, loadConfig({ INFORMER_CONFIG_FILE: MULTI }));
    expect(schema.required).toEqual(['administration', 'id']);
  });

  it('does not mutate the source schema', () => {
    const before = JSON.stringify(listRelations.inputSchema);
    withAdministration(listRelations.inputSchema, loadConfig({ INFORMER_CONFIG_FILE: MULTI }));
    expect(JSON.stringify(listRelations.inputSchema)).toBe(before);
  });
});
