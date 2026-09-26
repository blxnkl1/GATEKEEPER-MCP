/**
 * Process-wide pino logger.
 *
 * CRITICAL: the destination is `process.stderr`, never stdout.
 *
 * On the STDIO transport the MCP server speaks JSON-RPC on file descriptor 1
 * (stdout). A single stray byte on stdout - a `console.log`, a `debug` call
 * without a destination, a dependency that prints a banner - corrupts the
 * frame stream and makes the host client fail to parse our responses, with an
 * error that points nowhere near the real cause. Diagnostics are therefore
 * written exclusively to stderr, which no MCP host parses.
 */

import { pino } from 'pino'

/**
 * Shared logger instance.
 *
 * Kept at the default `info` level and unformatted so that the hot path stays
 * cheap. Set `PINO_LOG_LEVEL` in the environment to raise or lower the level,
 * and set `NODE_ENV=development` to get human-readable output via `pino-pretty`.
 */
export const logger = pino(
  {
    name: 'gatekeeper-mcp',
    level: process.env.PINO_LOG_LEVEL ?? 'info',
  },
  // stdout is reserved for the JSON-RPC frame stream, so logs go to stderr.
  process.stderr,
)
