#!/usr/bin/env node
/**
 * Packs the server into an .mcpb bundle for one-click installation.
 *
 *   npm run bundle        ->  informer-mcp.mcpb
 *
 * Claude Desktop does not run `npm install` for an extension, so the bundle has
 * to carry its own runtime dependencies. Everything is staged in build/bundle
 * with production dependencies only, and packed from there.
 */

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = join(root, 'build', 'bundle');

const COPY = ['dist', 'openapi', 'manifest.json', 'README.md', 'LICENSE', 'NOTICE'];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

await rm(join(root, 'build'), { recursive: true, force: true });
await mkdir(stage, { recursive: true });

for (const entry of COPY) {
  await cp(join(root, entry), join(stage, entry), { recursive: true });
}

// A trimmed package.json: production dependencies, and no scripts — `prepare`
// would try to run the TypeScript build inside a tree that has no compiler.
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const extension = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));

if (manifest.version !== extension.version) {
  console.error(
    `Version mismatch: package.json is ${manifest.version}, manifest.json is ${extension.version}. ` +
      'The extension manifest is what users see, so keep the two in step.',
  );
  process.exit(1);
}

await writeFile(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      license: manifest.license,
      type: manifest.type,
      main: manifest.main,
      dependencies: manifest.dependencies,
    },
    null,
    2,
  )}\n`,
);

console.log('\nInstalling production dependencies…');
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

console.log('\nPacking…');
run('npx', ['--yes', '@anthropic-ai/mcpb@latest', 'pack', stage, join(root, 'informer-mcp.mcpb')], root);

await rm(join(root, 'build'), { recursive: true, force: true });

console.log('\nWrote informer-mcp.mcpb — open it with Claude Desktop to install.');
