#!/usr/bin/env node
/**
 * Refreshes the vendored OpenAPI document from api.informer.eu.
 *
 *   npm run update-spec
 *
 * The tool surface is derived from this file, so review the diff (and run the
 * tests) after updating: new endpoints become new tools automatically.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SPEC_URL = process.env.INFORMER_SPEC_URL ?? 'https://api.informer.eu/docs/v2/api-docs.json';
const TARGET = fileURLToPath(new URL('../openapi/api-docs.json', import.meta.url));

const response = await fetch(SPEC_URL, { headers: { Accept: 'application/json' } });
if (!response.ok) {
  console.error(`Failed to download ${SPEC_URL}: HTTP ${response.status}`);
  process.exit(1);
}

const spec = await response.json();
if (!spec?.paths || typeof spec.paths !== 'object') {
  console.error('Downloaded document has no "paths" object — refusing to overwrite the vendored spec.');
  process.exit(1);
}

const before = existsSync(TARGET) ? Object.keys(JSON.parse(readFileSync(TARGET, 'utf8')).paths ?? {}) : [];
const after = Object.keys(spec.paths);

writeFileSync(TARGET, `${JSON.stringify(spec, null, 2)}\n`);

const added = after.filter((path) => !before.includes(path));
const removed = before.filter((path) => !after.includes(path));

console.log(`Wrote ${TARGET}`);
console.log(`API version ${spec.info?.version ?? 'unknown'} — ${after.length} paths`);
if (added.length > 0) console.log(`Added:   ${added.join(', ')}`);
if (removed.length > 0) console.log(`Removed: ${removed.join(', ')}`);
if (added.length === 0 && removed.length === 0) console.log('No paths added or removed.');
