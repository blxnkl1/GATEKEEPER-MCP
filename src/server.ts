/**
 * MCP server factory.
 *
 * Builds the `gatekeeper-mcp` server and registers every tool it exposes. Kept
 * free of transport concerns so that tests can instantiate the server without
 * touching stdin or stdout.
 */

import { createRequire } from 'node:module'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { type Config, ConfigError, loadConfig } from './config/loader.js'
import { type ServerContext, createServerContext } from './context.js'
import { realDeps } from './engine/analyzer.js'
import { logger } from './logger.js'
import { registerPreActionCheck } from './tools/pre_action_check.js'
import { registerVerifyDecision } from './tools/verify_decision.js'
import type { Deps, ServerOptions } from './types/index.js'

/** Server name advertised to MCP hosts during initialization. */
export const SERVER_NAME = 'gatekeeper-mcp'

/** Shape of the `package.json` fields the server needs. */
const packageManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
})

/**
 * Reads the version from the shipped `package.json`.
 *
 * Resolved with `createRequire` rather than a JSON import: the build output
 * lives in `dist/`, so a static import of the manifest would pull a file from
 * outside `rootDir` into the program. Both `src/server.ts` and `dist/server.js`
 * sit one level below the project root, so a single relative specifier works in
 * development and after a build.
 */
function readPackageVersion(): string {
  try {
    const manifest = packageManifestSchema.parse(createRequire(import.meta.url)('../package.json'))
    return manifest.version
  } catch (error) {
    // A missing or malformed manifest must not stop the server from starting;
    // the host still needs a server to talk to.
    logger.warn({ err: error }, 'server: could not read package version, falling back to 0.0.0')
    return '0.0.0'
  }
}

/**
 * Creates a fully wired MCP server instance.
 *
 * @param options Overrides, primarily for tests.
 * @returns A server ready to be connected to a transport.
 * @throws ConfigError when a configuration file exists but cannot be used. The
 *   caller is expected to refuse to start rather than fall back to defaults,
 *   because silently reverting to advisory mode would be a quiet downgrade of a
 *   setting the user deliberately chose.
 */
export function createServer(options: ServerOptions = {}): McpServer {
  const config: Config = options.config ?? loadConfig().config
  const context: ServerContext =
    options.context ??
    createServerContext(config, {
      ...(options.now === undefined ? {} : { now: options.now }),
    })

  // The repository root doubles as the path sandbox for reproductions and as the
  // directory git is consulted in, so it has to be overridable for tests that
  // assert on tree state. Without this seam a black-box test runs against
  // whatever directory the suite happens to be started in, which makes both the
  // tree verdict and the verification result meaningless.
  const deps: Deps =
    options.cwd === undefined && options.deps === undefined
      ? realDeps
      : {
          ...realDeps,
          ...(options.cwd === undefined ? {} : { cwd: () => options.cwd as string }),
          ...options.deps,
        }

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: options.version ?? readPackageVersion(),
    },
    {
      instructions:
        'Call `pre_action_check` before modifying any file. If it returns a deny or ' +
        'request_info decision, do not edit anything: report back or ask the user instead. ' +
        'Every response carries a `nonce`; pass it to `verify_decision` before reporting ' +
        'the decision to the user.',
      capabilities: {
        tools: {},
      },
    },
  )

  registerPreActionCheck(server, context, deps)
  registerVerifyDecision(server, context)

  logger.debug(
    { mode: config.mode, auditLog: config.auditLog.enabled },
    'server: created and tools registered',
  )
  return server
}

export { ConfigError }
