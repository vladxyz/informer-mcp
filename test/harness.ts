import type { CallToolResult, McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { vi } from 'vitest';

import type { InformerClient, RequestOptions } from '../src/client.js';
import type { Config } from '../src/config.js';
import { extractOperations, loadSpec, type Operation } from '../src/openapi.js';
import { registerTools, type ToolRegistry } from '../src/tools.js';

export const OPERATIONS: Operation[] = extractOperations(loadSpec());

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Registers the tools against a stub server so the real handlers can be called
 * directly, with a fake client standing in for the API.
 *
 * The stub mirrors the SDK where it matters: registering, updating and removing
 * a tool each emit their own list-changed notification, so the registry's
 * batching is actually under test.
 */
export function harness(config: Config, request: (options: RequestOptions) => Promise<unknown> = async () => ({})) {
  const handlers = new Map<string, Handler>();
  let listChanged = 0;

  const stub = {
    sendToolListChanged(): void {
      listChanged += 1;
    },

    registerTool(name: string, _toolConfig: unknown, callback: Handler): RegisteredTool {
      handlers.set(name, callback);
      stub.sendToolListChanged();

      return {
        update: () => stub.sendToolListChanged(),
        remove: () => {
          handlers.delete(name);
          stub.sendToolListChanged();
        },
      } as unknown as RegisteredTool;
    },
  };

  const server = stub as unknown as McpServer;
  const client = { request: vi.fn(request) } as unknown as InformerClient;
  const registry: ToolRegistry = registerTools({ server, client, config, operations: OPERATIONS });

  return {
    registry,
    get toolNames(): string[] {
      return registry.toolNames();
    },
    get listChangedCount(): number {
      return listChanged;
    },
    client: client as unknown as { request: ReturnType<typeof vi.fn> },
    has: (tool: string) => handlers.has(tool),
    call: async (tool: string, args: Record<string, unknown>) => {
      const handler = handlers.get(tool);
      if (!handler) throw new Error(`tool ${tool} was not registered`);
      const result = await handler(args);
      return { result, text: (result.content[0] as { text: string }).text };
    },
  };
}
