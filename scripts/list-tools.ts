#!/usr/bin/env tsx
/**
 * Prints the tool surface derived from the vendored spec.
 *
 *   npm run tools           # every tool, grouped by tag
 *   npm run tools -- --md   # markdown table, for the README
 */

import { loadConfig } from '../src/config.js';
import { extractOperations, loadSpec } from '../src/openapi.js';
import { selectOperations } from '../src/tools.js';

const asMarkdown = process.argv.includes('--md');
const operations = selectOperations(extractOperations(loadSpec()), loadConfig());

const byTag = new Map<string, typeof operations>();
for (const operation of operations) {
  const bucket = byTag.get(operation.tag) ?? [];
  bucket.push(operation);
  byTag.set(operation.tag, bucket);
}

if (asMarkdown) {
  for (const [tag, group] of byTag) {
    console.log(`\n### ${tag}\n`);
    console.log('| Tool | Endpoint | Description |');
    console.log('| --- | --- | --- |');
    for (const operation of group) {
      console.log(`| \`${operation.toolName}\` | \`${operation.method.toUpperCase()} ${operation.path}\` | ${operation.summary} |`);
    }
  }
} else {
  for (const [tag, group] of byTag) {
    console.log(`\n${tag}`);
    for (const operation of group) {
      const flag = operation.mutating ? 'W' : 'R';
      console.log(`  [${flag}] ${operation.toolName.padEnd(38)} ${operation.method.toUpperCase().padEnd(6)} ${operation.path}`);
    }
  }
  console.log(`\n${operations.length} tools`);
}
