/**
 * Programmatic entry point, for embedding the server or reusing its pieces.
 */

export { createServer, startupBanner, SERVER_NAME, SERVER_VERSION, REFRESH_TOOL, SETUP_TOOL } from './server.js';
export { startSetupServer, openBrowser, LIVE_HINT, RESTART_HINT, type SetupServer } from './setup.js';
export {
  fetchSpec,
  validateSpec,
  loadActiveSpec,
  readSpecCache,
  writeSpecCache,
  diffOperations,
  diffIsEmpty,
  summariseDiff,
  cacheIsStale,
  specUrl,
  specCachePath,
  specMaxAgeHours,
  SpecError,
  DEFAULT_SPEC_URL,
  type SpecDiff,
  type ActiveSpec,
} from './spec.js';
export { InformerClient, InformerApiError, InformerConfigError, buildPath, buildQuery, formatApiError } from './client.js';
export {
  ALL_ADMINISTRATIONS,
  loadConfig,
  loadAdministrations,
  administrationAliases,
  accessMode,
  writableAliases,
  hasCredentials,
  ConfigError,
  NO_CREDENTIALS_MESSAGE,
  type Config,
  type Administration,
  type AccessMode,
} from './config.js';
export { extractOperations, loadSpec, toolNameFor, type Operation, type OpenApiSpec } from './openapi.js';
export {
  registerTools,
  type ToolRegistry,
  type SyncResult,
  selectOperations,
  withAdministration,
  allowedAliases,
  supportsFanout,
  type SelectorOptions,
  resolveTargets,
  mapWithConcurrency,
  LIST_ADMINISTRATIONS_TOOL,
} from './tools.js';
