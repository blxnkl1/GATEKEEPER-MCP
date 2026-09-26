/**
 * Registration of the `pre_action_check` tool.
 *
 * This is the single public surface of the gatekeeper. An agent that is about
 * to modify code calls it first and is bound by the verdict it returns.
 *
 * The engine stays untouched. Everything in this file is transport concern:
 * rate limiting, the denylist, the audit trail, and the nonce that lets a later
 * call check whether the agent reported the decision it was actually given.
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'

import { hashText } from '../audit/audit-log.js'
import type { ServerContext } from '../context.js'
import { analyze, realDeps } from '../engine/analyzer.js'
import { logger } from '../logger.js'
import {
  type Denylist,
  createReproductionSchema,
  denylistReason,
  preActionCheckInputSchema,
  preActionCheckInputShape,
  preActionCheckOutputShape,
  preActionCheckResponseSchema,
} from '../schemas/pre_action_check.js'
import { generateNonce } from '../store/nonce-store.js'
import type { Deps } from '../types/index.js'
import { hasUnverifiedDecision } from './verify_decision.js'

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
  'Gatekeeper check. Call this BEFORE modifying any code. It verifies whether the change is justified by evidence and whether the task is already solved. If not justified, the agent MUST NOT edit files. Supply an executable reproduction under `reproduction` (a bare `command` plus `args`, never a shell string): free-text `evidenceOfProblem` alone is never enough to obtain an "allow". The response carries a `nonce`; pass it to `verify_decision` before reporting the decision.'

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
 * Every failure mode is contained here. A malformed argument, a validation
 * error, or a bug in the engine must not take the MCP session down: the host
 * expects a tool result, and a thrown error would surface as a protocol fault
 * pointing at the wrong place.
 *
 * @param server The MCP server to register the tool on.
 * @param context Shared server state.
 * @param deps Engine dependencies. Defaults to the real Node built-ins; tests
 *   override the repository root so tree state is deterministic.
 * @returns The registered tool handle, useful for tests and teardown.
 */
export function registerPreActionCheck(
  server: McpServer,
  context: ServerContext,
  deps: Deps = realDeps,
): RegisteredTool {
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
    async (args, extra) => {
      try {
        const now = Date.now()

        // Rate limit before doing any work, so a runaway loop cannot make the
        // engine spawn processes. A refused request is still counted by the
        // limiter, which is what stops a retry loop from defeating the budget.
        const verdict = context.limiter.check()
        if (!verdict.allowed) {
          logger.info(
            { count: verdict.count, windowMs: verdict.windowMs, max: verdict.max },
            'pre_action_check rate limited',
          )
          context.audit.write({
            event: 'rate_limit_exceeded',
            count: verdict.count,
            windowMs: verdict.windowMs,
            max: verdict.max,
          })
          return rateLimited(verdict.count, verdict.max, verdict.windowMs)
        }

        // Enforced mode: an unverified recent decision blocks the next call. This
        // is a sequence check, not an edit check. See ADR 0006.
        if (hasUnverifiedDecision(context, now)) {
          const previous = context.lastIssued
          logger.info(
            { previousNonce: previous?.nonce, previousDecision: previous?.decision },
            'pre_action_check sequence violation',
          )
          return sequenceViolation()
        }

        // Validate with the config-derived denylist rather than the static one
        // advertised above, so a user's denylist is actually enforced. The static
        // schema still carries the built-in list, which keeps the advertised
        // contract honest for a client reading the tool metadata.
        const input = preActionCheckInputSchema.parse({
          ...args,
          ...(args.reproduction === undefined
            ? {}
            : {
                reproduction: createReproductionSchema(context.config.denylist).parse(
                  args.reproduction,
                ),
              }),
        })

        const result = await analyze(input, deps, {
          ...(context.config.testCommand === undefined
            ? {}
            : { testCommand: context.config.testCommand }),
          ...(context.config.testTimeoutMs === undefined
            ? {}
            : { testTimeoutMs: context.config.testTimeoutMs }),
        })
        const nonce = generateNonce()

        // Record the nonce before returning, so a verification that arrives
        // immediately still finds it.
        context.nonces.issue(nonce, result.decision)
        context.lastIssued = { nonce, decision: result.decision, at: now }

        const response = preActionCheckResponseSchema.parse({ ...result, nonce })

        context.audit.write({
          event: 'pre_action_check',
          nonce,
          decision: result.decision,
          taskHash: hashText(input.taskDescription),
        })

        logger.info(
          {
            decision: response.decision,
            evidence: response.evidence.state,
            mode: context.config.mode,
          },
          'pre_action_check completed',
        )

        void extra
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
          structuredContent: response,
        }
      } catch (error) {
        // A denylist rejection is a policy decision, not a malfunction, so it is
        // reported as itself. Folding it into the generic handler error made the
        // server tell an agent to "report this as a bug" for what was a
        // deliberate refusal, which is both wrong and unactionable.
        const refusal = denylistRefusal(context.config.denylist, args)
        if (refusal !== null) {
          logger.info({ command: refusal.command }, 'pre_action_check denylist rejection')
          context.audit.write({ event: 'denylist_rejected', command: refusal.command })
          return {
            isError: true,
            content: [{ type: 'text' as const, text: refusal.message }],
          }
        }

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

/**
 * Builds a refusal for a rate-limited call.
 *
 * The response is a normal deny-shaped payload rather than a tool error: being
 * throttled is a decision the gate reached, not a failure of the tool, and an
 * agent that sees `isError` is likely to retry harder. It carries no nonce,
 * because no analysis ran and so there is nothing to verify.
 *
 * @param count Requests seen in the window.
 * @param max The budget.
 * @param windowMs The window length.
 * @returns A tool result carrying the deny, shaped like any other response.
 */
function rateLimited(count: number, max: number, windowMs: number) {
  const payload = {
    decision: 'deny' as const,
    reason: `Rate limit exceeded: ${count} per ${windowMs} ms.`,
    nextSteps: [
      'Do not modify any file.',
      'Wait for the rate limit window to pass before asking again.',
      'If you are looping, re-read the task: repeated calls usually mean the evidence is not improving.',
    ],
    evidence: {
      state: 'unverifiable' as const,
      detail: `No analysis was performed. The request budget of ${max} per ${windowMs} ms is exhausted.`,
    },
    state: {
      workingTree: 'unknown' as const,
      tests: 'skipped' as const,
      detail: 'No repository inspection: the request was refused before analysis.',
    },
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}

/**
 * Builds a refusal for a sequence violation in enforced mode.
 *
 * @returns A tool result carrying the deny, shaped like any other response.
 */
function sequenceViolation() {
  const payload = {
    decision: 'deny' as const,
    reason: 'Previous decision not verified. Call verify_decision first.',
    nextSteps: [
      'Do not modify any file.',
      'Call verify_decision with the nonce from the previous pre_action_check response.',
      'Then re-run pre_action_check.',
    ],
    evidence: {
      state: 'unverifiable' as const,
      detail: 'No analysis was performed. The previous decision is still unverified.',
    },
    state: {
      workingTree: 'unknown' as const,
      tests: 'skipped' as const,
      detail: 'No repository inspection: the request was refused before analysis.',
    },
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}

/**
 * Determines whether raw arguments were refused by the denylist.
 *
 * The generic error path cannot tell a denied command from a malformed
 * argument, so the refusal is recomputed from the raw arguments the agent sent.
 * Because the advertised tool schema deliberately omits the denylist check, this
 * is the single place a denied command is stopped, and therefore the single
 * place a `denylist_rejected` audit event can be written.
 *
 * @param denylist The active denylist.
 * @param args The raw arguments the agent supplied.
 * @returns The refusal, or null when the failure was not a denylist rejection.
 */
function denylistRefusal(
  denylist: Denylist,
  args: unknown,
): { command: string; message: string } | null {
  if (typeof args !== 'object' || args === null) {
    return null
  }
  const reproduction = (args as { reproduction?: { command?: unknown; args?: unknown } })
    .reproduction
  if (typeof reproduction?.command !== 'string') {
    return null
  }
  const rawArgs = reproduction.args
  const argv = Array.isArray(rawArgs)
    ? rawArgs.filter((a): a is string => typeof a === 'string')
    : []

  const message = denylistReason(reproduction.command, denylist, argv)
  if (message === null) {
    return null
  }
  return { command: reproduction.command, message }
}
