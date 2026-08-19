#!/usr/bin/env node
/**
 * Entry point: serves the Informer MCP server over stdio, or opens the setup UI.
 *
 * stdout is reserved for the MCP transport, so all diagnostics go to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { hasCredentials } from './config.js';
import { createServer, startupBanner, SERVER_VERSION } from './server.js';
import { openBrowser, startSetupServer } from './setup.js';

const USAGE = `informer-mcp ${SERVER_VERSION} — MCP server for the InformerOnline API

Usage:
  informer-mcp [options]     serve MCP over stdio
  informer-mcp setup         open a local page to enter your API credentials

Options:
  --read-only     Expose only the tools that read. Overrides INFORMER_READ_ONLY.
  --read-write    Expose the tools that create, update and delete as well.
  -h, --help      Show this message.
  -v, --version   Show the version.

Individual client administrations can be restricted further with
"mode": "read-only" in the config file. The most restrictive setting wins:
--read-only clamps every administration, and a client marked read-only stays
read-only even under --read-write.

Credentials:
  informer-mcp setup                          fill them in from the browser
  INFORMER_API_KEY, INFORMER_SECURITY_CODE    a single administration
  INFORMER_CONFIG_FILE                        several (default ~/.informer-mcp.json)

Starting the server without any credentials opens the setup page automatically;
set INFORMER_AUTO_SETUP=false to turn that off.
`;

function fail(message: string): never {
  process.stderr.write(`informer-mcp: ${message}\n`);
  process.exit(1);
}

/** Command-line flags win over the environment, so a client can pin the mode. */
function applyFlags(argv: string[]): void {
  for (const arg of argv) {
    switch (arg) {
      case '--read-only':
        process.env.INFORMER_READ_ONLY = 'true';
        break;
      case '--read-write':
        process.env.INFORMER_READ_ONLY = 'false';
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '-v':
      case '--version':
        process.stdout.write(`${SERVER_VERSION}\n`);
        process.exit(0);
        break;
      default:
        fail(`unknown option ${arg}. Try --help.`);
    }
  }
}

/** `informer-mcp setup`: open the page, wait until credentials are written. */
async function runSetup(): Promise<never> {
  const setup = await startSetupServer();

  process.stdout.write(`Opening ${setup.url}\n`);
  process.stdout.write('Leave this running until you have saved, then press Ctrl+C if it does not exit by itself.\n');
  openBrowser(setup.url);

  const path = await setup.saved;
  await setup.close();

  process.stdout.write(`\nSaved your credentials to ${path}\n`);
  process.exit(0);
}

/** Serving without credentials is the install moment: offer the page instead of failing. */
function offerSetup(): void {
  if (process.env.INFORMER_AUTO_SETUP?.trim().toLowerCase() === 'false') return;

  void created
    .openSetup()
    .then((page) => {
      process.stderr.write(`informer-mcp: no credentials configured — opening ${page.url}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `informer-mcp: could not start the setup page (${error instanceof Error ? error.message : String(error)}). ` +
          'Run "informer-mcp setup" manually.\n',
      );
    });
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'setup') {
  if (rest.length > 0) fail(`setup takes no options, got ${rest.join(' ')}.`);
  await runSetup();
}

applyFlags(process.argv.slice(2));

const created = (() => {
  try {
    return createServer();
  } catch (error) {
    fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
})();

process.stderr.write(`${startupBanner(created)}\n`);



const handle = serveStdio(() => created.server, {
  onerror: (error) => process.stderr.write(`informer-mcp transport error: ${error.message}\n`),
});

// Only once the transport is up, so a changed tool list reaches the client.
created.autoRefresh();
if (!hasCredentials(created.config)) offerSetup();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
