/**
 * Assembles the MCP server: tools for every API operation, a tool that refreshes
 * the OpenAPI document in place, and a resource that exposes the document itself.
 */

import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';

import { InformerClient, type FetchLike } from './client.js';
import { administrationAliases, hasCredentials, loadConfig, writableAliases, type Config } from './config.js';
import { LIVE_HINT, openBrowser, startSetupServer, type SetupServer } from './setup.js';
import { extractOperations, type OpenApiSpec, type Operation } from './openapi.js';
import {
  cacheIsStale,
  diffIsEmpty,
  diffOperations,
  fetchSpec,
  loadActiveSpec,
  specCachePath,
  specMaxAgeHours,
  specUrl,
  summariseDiff,
  writeSpecCache,
  type ActiveSpec,
  type SpecDiff,
} from './spec.js';
import { LIST_ADMINISTRATIONS_TOOL } from './names.js';
import { registerTools, type ToolRegistry } from './tools.js';

export const SERVER_NAME = 'informer';
export const SERVER_VERSION = '1.0.0';
export { REFRESH_TOOL, SETUP_TOOL } from './names.js';

import { REFRESH_TOOL, SETUP_TOOL } from './names.js';

const SPEC_URI = 'informer://openapi.json';

export interface CreateServerOptions {
  config?: Config;
  /** Overrides the spec that would otherwise be loaded from cache or the bundle. */
  spec?: OpenApiSpec;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Injected so refresh timestamps stay reproducible in tests. */
  now?: () => Date;
}

export interface RefreshOutcome {
  diff: SpecDiff;
  adopted: boolean;
  apiVersion?: string;
  paths: number;
  tools: number;
  fetchedAt: string;
}

export interface CreatedServer {
  server: McpServer;
  registry: ToolRegistry;
  operations: Operation[];
  toolNames: string[];
  config: Config;
  activeSpec: ActiveSpec;
  /** Downloads the document and, unless `dryRun`, adopts it. */
  refresh(dryRun?: boolean): Promise<RefreshOutcome>;
  /** Refreshes in the background when the cached document is stale. */
  autoRefresh(): void;
  /** Re-reads the config file and re-advertises the tools it affects. */
  reloadConfig(): void;
  /** Starts the setup page, or returns the one already running. */
  openSetup(): Promise<SetupServer>;
  /** Shuts down the setup page if one is open. */
  closeSetup(): Promise<void>;
}

export function createServer(options: CreateServerOptions = {}): CreatedServer {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  const now = options.now ?? (() => new Date());

  const activeSpec: ActiveSpec = options.spec ? { spec: options.spec, source: 'bundled' } : loadActiveSpec(env);
  let spec = activeSpec.spec;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions:
        'Tools for the Informer (informer.nl) bookkeeping API. ' +
        'List endpoints are paginated through the "page" and "records" arguments and return a "pagination" object. ' +
        'All dates use the YYYY-MM-DD format. ' +
        'Create/update tools take the payload in the "body" argument; call the matching "*_options" tool first when you ' +
        'need valid ledger, VAT or template ids. ' +
        'When several client administrations are configured, every tool requires an "administration" argument; ' +
        'call list_administrations to see the aliases, which company each one is, and which may be written to. ' +
        `If an endpoint seems to be missing or an argument is rejected as unknown, call ${REFRESH_TOOL}: it downloads ` +
        'the current API description from Informer and updates the tools in place. ' +
        `Anything to do with configuration — settings, credentials, API keys, adding or removing a client, or a call ` +
        `rejected with 401 — is handled by ${SETUP_TOOL}. Call it instead of looking for config files, reading the ` +
        'installation directory, or asking the user for a key in the conversation.',
    },
  );

  const client = new InformerClient(config, options.fetchImpl);
  const registry = registerTools({ server, client, config, operations: extractOperations(spec) });

  async function refresh(dryRun = false): Promise<RefreshOutcome> {
    const url = specUrl(env);
    const downloaded = await fetchSpec(url, options.fetchImpl);
    const next = extractOperations(downloaded);
    const diff = diffOperations(registry.operations(), next);

    const outcome: RefreshOutcome = {
      diff,
      adopted: !dryRun,
      ...(downloaded.info?.version ? { apiVersion: downloaded.info.version } : {}),
      paths: Object.keys(downloaded.paths).length,
      tools: next.length,
      fetchedAt: now().toISOString(),
    };

    if (dryRun) return outcome;

    await writeSpecCache(specCachePath(env), downloaded, url, outcome.fetchedAt);
    spec = downloaded;

    registry.sync(next);
    return outcome;
  }

  server.registerTool(
    REFRESH_TOOL,
    {
      title: 'Refresh the Informer API description',
      description:
        "Download the current OpenAPI description from Informer and update this server's tools to match, without " +
        'restarting. New endpoints become new tools, removed ones disappear, and changed arguments are re-advertised. ' +
        'Use it when an endpoint you expect is missing, when an argument is rejected as unknown, or to check whether ' +
        'Informer has changed anything. Pass dry_run to see the differences without applying them. This only touches ' +
        'this server; it never changes bookkeeping data.',
      inputSchema: fromJsonSchema<{ dry_run?: boolean }>({
        type: 'object',
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'Report what would change without adopting the new description. Defaults to false.',
          },
        },
        additionalProperties: false,
      }),
      annotations: {
        title: 'Refresh the Informer API description',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const outcome = await refresh(args?.dry_run === true);
        const { diff } = outcome;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  adopted: outcome.adopted,
                  api_version: outcome.apiVersion ?? null,
                  endpoints: outcome.paths,
                  tools: outcome.tools,
                  fetched_at: outcome.fetchedAt,
                  changes: diffIsEmpty(diff)
                    ? 'none — the tools already match the published API'
                    : { added: diff.added, removed: diff.removed, changed: diff.changed, unchanged: diff.unchanged },
                  note: outcome.adopted
                    ? 'The tool list has been updated; no restart is needed.'
                    : 'Nothing was applied. Call again without dry_run to adopt it.',
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  let setup: SetupServer | undefined;

  /** Picks up a config written by the setup page without restarting the client. */
  function reloadConfig(): void {
    Object.assign(config, loadConfig(env));
    registry.sync(registry.operations());
  }

  /**
   * The setup page, started at most once. Both the tool and the automatic offer
   * on a credential-less start come through here, so there is never a second one.
   */
  async function openSetup(): Promise<SetupServer> {
    if (setup) return setup;

    const started = await startSetupServer({ env, savedHint: LIVE_HINT });
    setup = started;

    void started.saved.then(async () => {
      reloadConfig();
      process.stderr.write('informer-mcp: credentials updated from the setup page\n');
      await started.close();
      if (setup === started) setup = undefined;
    });

    // Do not keep a forgotten page listening forever.
    setTimeout(
      () => {
        if (setup !== started) return;
        setup = undefined;
        void started.close();
      },
      30 * 60_000,
    ).unref?.();

    openBrowser(started.url, env);
    return started;
  }

  server.registerTool(
    SETUP_TOOL,
    {
      title: 'Open the Informer configuration page',
      description:
        'Open the Informer settings, configuration or setup page. This is the single answer to every request about ' +
        'configuring this server: first-time setup, "open the config/settings/configuration site", adding a client or ' +
        'administration, changing or rotating an API key or security code, switching a client between read-only and ' +
        'read-write, removing one, or fixing a call that failed with 401 Authentication failed. It opens a form on ' +
        "127.0.0.1 in the user's browser, one card per administration: alias, company name, API key, security code, " +
        'access. Call this instead of searching the filesystem for config files, reading the installation directory, ' +
        'running the setup command in a shell, or asking the user for a key in the conversation — credentials belong ' +
        'in the page, not in a chat. Returns the URL to pass on in case the browser did not open. Saving verifies ' +
        'each key against the API and applies the change to this server immediately.',
      inputSchema: fromJsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
      annotations: {
        title: 'Open the Informer configuration page',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const page = await openSetup();
        const aliases = administrationAliases(config);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  url: page.url,
                  opened_in_browser: env.INFORMER_OPEN_BROWSER?.trim().toLowerCase() !== 'false',
                  configured_now: aliases.length > 0 ? aliases : 'none yet',
                  instructions:
                    'The page is open. Give the user the URL in case the browser did not come to the front, and stop ' +
                    'there — do not run shell commands, read config files or ask for credentials. Saving verifies ' +
                    'each key against the API and applies the change to this server straight away, with no restart, ' +
                    `so afterwards you can confirm with ${LIST_ADMINISTRATIONS_TOOL}.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );

  server.registerResource(
    'openapi',
    SPEC_URI,
    {
      title: 'Informer OpenAPI document',
      description: 'The OpenAPI 3.0 specification these tools are generated from.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(spec) }],
    }),
  );

  function autoRefresh(): void {
    if (!cacheIsStale(env)) return;

    void refresh()
      .then((outcome) => {
        process.stderr.write(
          `informer-mcp: API description refreshed — ${summariseDiff(outcome.diff)}, ${outcome.tools} tools\n`,
        );
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `informer-mcp: could not refresh the API description (${
            error instanceof Error ? error.message : String(error)
          }); continuing with the one already loaded\n`,
        );
      });
  }

  return {
    server,
    registry,
    operations: registry.operations(),
    toolNames: registry.toolNames(),
    config,
    activeSpec,
    refresh,
    autoRefresh,
    reloadConfig,
    openSetup,
    closeSetup: async () => {
      await setup?.close();
      setup = undefined;
    },
  };
}

/** One-line startup summary written to stderr (stdout is the MCP transport). */
export function startupBanner(
  { toolNames, config, activeSpec }: CreatedServer,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const aliases = administrationAliases(config);
  const writable = writableAliases(config);

  const access = !hasCredentials(config)
    ? config.readOnly
      ? 'read-only'
      : 'read-write'
    : writable.length === 0
      ? 'read-only'
      : writable.length === aliases.length
        ? 'read-write'
        : `read-write: ${writable.join(', ')}`;

  const spec =
    activeSpec.source === 'cache' && activeSpec.fetchedAt
      ? `spec downloaded ${activeSpec.fetchedAt.slice(0, 10)}`
      : 'spec bundled';

  return [
    `informer-mcp ${SERVER_VERSION}`,
    `${toolNames.length + 2} tools`,
    access,
    config.baseUrl,
    `${spec}${specMaxAgeHours(env) === 0 ? ', auto-refresh off' : ''}`,
    hasCredentials(config)
      ? `administrations: ${aliases.join(', ')}${aliases.length > 1 ? ' (argument required)' : ''}`
      : 'WARNING: no administration configured',
  ].join(' | ');
}
