#!/usr/bin/env node
/**
 * Entrypoint for the `gatekeeper-mcp` binary.
 *
 * Wires the server to a STDIO transport and nothing else. No argument parsing,
 * no config loading, no network: an MCP host spawns this process, speaks
 * JSON-RPC to it over stdin and stdout, and kills it when the session ends.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { describeConfigError } from './config/loader.js'
import { logger } from './logger.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  // A configuration file that cannot be used is a hard stop. Falling back to
  // defaults here would silently revert a user's `mode: "enforced"` to advisory
  // after a typo, which is the same class of quiet downgrade this project exists
  // to prevent.
  let server: McpServer
  try {
    server = createServer()
  } catch (error) {
    // stderr only: stdout is the JSON-RPC channel and must stay clean even here.
    process.stderr.write(`${describeConfigError(error)}\n`)
    process.exitCode = 78 // EX_CONFIG
    return
  }

  const transport = new StdioServerTransport()

  await server.connect(transport)

  // stderr, never stdout: stdout is the JSON-RPC channel.
  logger.info('gatekeeper-mcp started on stdio transport')

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'gatekeeper-mcp shutting down')
    void server.close().finally(() => {
      process.exit(0)
    })
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'gatekeeper-mcp failed to start')
  process.exitCode = 1
})
