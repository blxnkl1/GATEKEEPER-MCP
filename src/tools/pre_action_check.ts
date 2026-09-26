/**
 * Registration of the `pre_action_check` tool.
 *
 * This is the single public surface of the gatekeeper. An agent that is about
 * to modify code calls it first and is bound by the verdict it returns.
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'

import { analyze } from '../engine/analyzer.js'
import { logger } from '../logger.js'
import {
  preActionCheckInputSchema,
  preActionCheckInputShape,
  preActionCheckOutputSchema,
  preActionCheckOutputShape,
} from '../schemas/pre_action_check.js'

/** Name of the tool as exposed over MCP. */
export const PRE_ACTION_CHECK_TOOL_NAME = 'pre_action_check'

/**
 * Description shown to the agent in its tool list.
 *
 * Wording is deliberately imperative: the agent reads this before deciding
 * whether the tool is worth calling, so it states both when to call it and
 * what it is forbidden to do with a denial. The sentence about executable
 * evidence is the part that changes behaviour, because most agents default to
 * pasting free text and would otherwise be surprised by `request_info`.
 */
export const PRE_ACTION_CHECK_DESCRIPTION =
  'Gatekeeper check. Call this BEFORE modifying any code. It verifies whether the change is justified by evidence and whether the task is already solved. If not justified, the agent MUST NOT edit files. Supply an executable reproduction under `reproduction` (a bare `command` plus `args`, never a shell string): free-text `evidenceOfProblem` alone is never enough to obtain an "allow".'

/**
 * Message returned to the agent when the check itself fails.
 *
 * Deliberately vague about the cause. Stack traces and internal error messages
 * can contain absolute paths, environment values, and command lines, none of
 * which belong in a tool result that an agent may echo back to a user. The full
 * error goes to stderr, where only the operator can see it.
 */
const INTERNAL_ERROR_MESSAGE =
  'pre_action_check could not complete. Nothing has been changed. Re-run with a simpler reproduction, or report this as a bug.'

/**
 * Registers the `pre_action_check` tool on a server instance.
 *
 * The handler inspects the agent's claims and returns a verdict. It never
 * modifies the repository, and it never writes to stdout, since stdout carries
 * the JSON-RPC frame stream.
 *
 * Every failure mode is contained here. A malformed argument, a validation
 * error, or a bug in the engine must not take the MCP session down: the host
 * expects a tool result, and a thrown error would surface as a protocol fault
 * pointing at the wrong place.
 *
 * @param server The MCP server to register the tool on.
 * @returns The registered tool handle, useful for tests and teardown.
 */
export function registerPreActionCheck(server: McpServer): RegisteredTool {
  return server.registerTool(
    PRE_ACTION_CHECK_TOOL_NAME,
    {
      title: 'Pre-action gatekeeper check',
      description: PRE_ACTION_CHECK_DESCRIPTION,
      inputSchema: preActionCheckInputShape,
      outputSchema: preActionCheckOutputShape,
      annotations: {
        // The tool inspects and reports. It spawns the agent's own reproduction
        // command, which is a side effect the agent requested explicitly and
        // controls, but it never mutates the repository itself.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Everything it needs was passed in the call arguments. It performs no
        // network access, so it does not reach outside the machine.
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        // Re-validate explicitly. The SDK already parsed `args` against the
        // input schema, but parsing here guarantees the engine only ever sees a
        // value that satisfies our own contract, and turns a bad argument into
        // a message the agent can act on rather than a protocol error.
        const input = preActionCheckInputSchema.parse(args)
        const result = await analyze(input)

        // Validate the output too, so a bug in the engine surfaces as a clear
        // schema error instead of a malformed response the agent must guess at.
        const output = preActionCheckOutputSchema.parse(result)

        logger.debug(
          { decision: output.decision, evidence: output.evidence.state },
          'pre_action_check completed',
        )

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        }
      } catch (error) {
        // Full detail to stderr for the operator; a safe summary to the agent.
        logger.error({ err: error }, 'pre_action_check failed')
        return {
          isError: true,
          content: [{ type: 'text' as const, text: INTERNAL_ERROR_MESSAGE }],
        }
      }
    },
  )
}
