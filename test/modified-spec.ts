import { loadSpec, type OpenApiSpec } from '../src/openapi.js';

/**
 * The bundled document with one endpoint added, one removed and one request body
 * given an extra required field — a stand-in for Informer changing their API.
 */
export function modifiedSpec(): OpenApiSpec {
  const spec = JSON.parse(JSON.stringify(loadSpec())) as OpenApiSpec;

  spec.paths['/widgets'] = {
    get: {
      tags: ['Widgets'],
      summary: 'Get all widgets',
      responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } } },
    },
  };
  delete spec.paths['/products'];

  const input = spec.components?.schemas?.SalesInvoiceInput as { required?: string[] } | undefined;
  input?.required?.push('project_id');

  return spec;
}
