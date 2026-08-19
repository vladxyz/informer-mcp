import { describe, expect, it } from 'vitest';

import { extractOperations, loadSpec, toolNameFor, type Operation } from '../src/openapi.js';

const operations = extractOperations(loadSpec());
const byName = new Map<string, Operation>(operations.map((operation) => [operation.toolName, operation]));

describe('toolNameFor', () => {
  it.each([
    ['get', '/relations', 'list_relations'],
    ['post', '/relations', 'create_relation'],
    ['get', '/relations/{id}', 'get_relation'],
    ['put', '/relations/{id}', 'update_relation'],
    ['get', '/administration', 'get_administration'],
    ['get', '/invoices/sales', 'list_sales_invoices'],
    ['get', '/invoices/sales/pdf/{id}', 'get_sales_invoice_pdf'],
    ['post', '/invoices/sales/send/{id}', 'send_sales_invoice'],
    ['post', '/invoices/sales/{id}/attachments', 'upload_sales_invoice_attachment'],
    ['delete', '/invoices/sales/{id}/attachments/{attachment_id}', 'delete_sales_invoice_attachment'],
    ['get', '/reports/column-balance', 'get_column_balance_report'],
  ] as const)('maps %s %s to %s', (method, path, expected) => {
    expect(toolNameFor(method, path)).toBe(expected);
  });

  it('falls back to a slug for unknown paths', () => {
    expect(toolNameFor('get', '/brand-new/thing')).toBe('get_brand_new_thing');
  });
});

describe('extractOperations', () => {
  it('covers every operation in the spec', () => {
    expect(operations.length).toBeGreaterThanOrEqual(68);
  });

  it('produces unique tool names', () => {
    expect(byName.size).toBe(operations.length);
  });

  it('produces snake_case tool names', () => {
    for (const operation of operations) {
      expect(operation.toolName).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('marks non-GET operations as mutating', () => {
    expect(byName.get('create_relation')?.mutating).toBe(true);
    expect(byName.get('list_relations')?.mutating).toBe(false);
  });

  it('requires path parameters', () => {
    const schema = byName.get('get_relation')?.inputSchema;
    expect(schema?.required).toEqual(['id']);
  });

  it('exposes query parameters as optional arguments', () => {
    const properties = byName.get('list_relations')?.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['page', 'records', 'search', 'last_edit']));
    expect(byName.get('list_relations')?.inputSchema.required).toBeUndefined();
  });

  it('nests request bodies under "body" and inlines referenced schemas', () => {
    const operation = byName.get('create_sales_invoice');
    const properties = operation?.inputSchema.properties as Record<string, unknown>;
    expect(properties.body).toBeDefined();
    expect(operation?.inputSchema.required).toContain('body');
    expect(Object.keys(operation?.inputSchema.$defs as Record<string, unknown>)).toContain('SalesInvoiceInput');
  });

  it('rewrites component refs into $defs', () => {
    const defs = byName.get('create_sales_invoice')?.inputSchema.$defs as Record<string, unknown>;
    expect(JSON.stringify(defs)).not.toContain('#/components/schemas/');
    expect(JSON.stringify(defs)).toContain('#/$defs/');
  });

  it('converts nullable schemas into null unions', () => {
    const defs = byName.get('create_sales_invoice')?.inputSchema.$defs as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(defs)).not.toContain('"nullable"');
  });

  it('adds save_path to base64 download tools', () => {
    for (const name of ['get_sales_invoice_pdf', 'download_sales_invoice_attachment']) {
      const properties = byName.get(name)?.inputSchema.properties as Record<string, unknown>;
      expect(properties.save_path, name).toBeDefined();
    }
    const properties = byName.get('list_relations')?.inputSchema.properties as Record<string, unknown>;
    expect(properties.save_path).toBeUndefined();
  });
});
