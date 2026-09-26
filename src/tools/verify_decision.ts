/**
 * Registration of the `verify_decision` tool.
 *
 * In Phase 4 a real agent reported a `pre_action_check` verdict the server never
 * sent: the server said `deny` and the agent reported `allow`. Nothing in the
 * protocol could catch that, because the agent's own account of what it did was
 * the only evidence available.
 *
 * This tool is the second half of the fix. Every reply carries a nonce, and
 * before reporting a decision the agent presents that nonce together with the
 * decision it intends to report. A mismatch is recorded as
 * `fabrication_suspected`, which turns a dispute into a query against the audit
 * log.
 *
 * The honest limit, stated here as well as in ADR 0006: this detects
 * misreporting. It cannot stop a file being edited, because MCP has no mechanism
 * for that. It is a tripwire, not a lock.
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { hashText } from '../audit/audit-log.js'
import { ENFORCEMENT_WINDOW_MS, type ServerContext } from '../context.js'
import { logger } from '../logger.js'
import { decisionSchema } from '../schemas/pre_action_check.js'

/** Name of the tool as exposed over MCP. */
export const VERIFY_DECISION_TOOL_NAME = 'verify_decision'

/** Raw input shape, exported for the MCP tool metadata. */
export const verifyDecisionInputShape = {
  nonce: z.string().min(1).describe('The nonce from the pre_action_check response being reported.'),
  decision: decisionSchema.describe('The decision you intend to report to the user.'),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe('Your own summary of the decision. Optional, and not verified.'),
} as const

/** Raw output shape, exported for the MCP tool metadata. */
export const verifyDecisionOutputShape = {
  valid: z.boolean().describe('Whether the reported decision matches what the server issued.'),
  reason: z.string().min(1).describe('Why verification succeeded or failed.'),
  originalDecision: decisionSchema
    .optional()
    .describe('The decision the server actually issued, when known.'),
} as const

/** Validated input. */
export const verifyDecisionInputSchema = z.object(verifyDecisionInputShape)

/** Validated output. */
export const verifyDecisionOutputSchema = z.object(verifyDecisionOutputShape)

/**
 * Registers `verify_decision` on a server.
 *
 * @param server The MCP server to register on.
 * @param context Shared server state.
 * @returns The registered tool handle.
 */
export function registerVerifyDecision(server: McpServer, context: ServerContext): RegisteredTool {
  return server.registerTool(
    VERIFY_DECISION_TOOL_NAME,
    {
      title: 'Verify a reported gatekeeper decision',
      description:
        'Check a decision before reporting it. Pass the nonce from a pre_action_check response together with the decision you intend to report. If verification fails, report the failure instead of the decision: an unverified decision is worse than no decision.',
      inputSchema: verifyDecisionInputShape,
      outputSchema: verifyDecisionOutputShape,
      annotations: {
        // Reads the nonce store and appends to the audit log. It changes no code
        // and no file other than the log itself.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      // Verification is a security-relevant operation and was previously the one
      // call with no budget at all, so a loop could spend unbounded time and
      // unbounded audit-log growth on it. The budget is deliberately generous
      // and separate from the pre-action budget, because enforced mode requires
      // a verification between two checks and must not have that verification
      // eaten by the limiter that governs the checks.
      const budget = context.verifyLimiter.check()
      if (!budget.allowed) {
        logger.info(
          { count: budget.count, windowMs: budget.windowMs, max: budget.max },
          'verify_decision rate limited',
        )
        context.audit.write({
          event: 'rate_limit_exceeded',
          count: budget.count,
          windowMs: budget.windowMs,
          max: budget.max,
        })
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'verify_decision rate limited. Wait for the window to pass before verifying again.',
            },
          ],
        }
      }

      const input = verifyDecisionInputSchema.parse(args)
      const consumed = context.nonces.consume(input.nonce)

      // An unknown or already-spent nonce is the same failure from the caller's
      // point of view, and saying only that avoids confirming which it was.
      if (consumed === null) {
        logger.info(
          { nonce: input.nonce, claimed: input.decision, valid: false },
          'pre_action_check decision',
        )
        context.audit.write({
          event: 'verify_decision',
          nonce: input.nonce,
          valid: false,
          claimed: input.decision,
          issued: null,
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  valid: false,
                  reason: 'Nonce unknown or already consumed.',
                },
                null,
                2,
              ),
            },
          ],
          structuredContent: { valid: false, reason: 'Nonce unknown or already consumed.' },
        }
      }

      if (consumed.decision !== input.decision) {
        // The mismatch is the whole point of this tool, so it is recorded under
        // its own event name rather than folded into the generic verification
        // record. That is what makes it greppable later.
        logger.info(
          {
            nonce: input.nonce,
            claimed: input.decision,
            actual: consumed.decision,
            valid: false,
          },
          'pre_action_check decision',
        )
        context.audit.write({
          event: 'fabrication_suspected',
          nonce: input.nonce,
          claimed: input.decision,
          actual: consumed.decision,
        })
        const output = {
          valid: false,
          reason: 'Decision does not match issued nonce.',
          originalDecision: consumed.decision,
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        }
      }

      // Verified. Clearing lastIssued is what lets enforced mode accept the next
      // call, so it happens here and nowhere else.
      if (context.lastIssued?.nonce === input.nonce) {
        context.lastIssued = null
      }

      logger.info(
        {
          nonce: input.nonce,
          claimed: input.decision,
          valid: true,
          reasonHash: hashText(input.reason ?? ''),
        },
        'pre_action_check decision',
      )
      context.audit.write({
        event: 'verify_decision',
        nonce: input.nonce,
        valid: true,
        claimed: input.decision,
        issued: consumed.decision,
      })
      const output = { valid: true, reason: 'Decision verified.' }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      }
    },
  )
}

/**
 * Whether enforced mode should refuse a new call.
 *
 * The rule: a decision was issued recently and never verified. "Recently" is a
 * window rather than forever, so a forgotten verification does not wedge an
 * agent permanently after it has moved on to unrelated work.
 *
 * @param context Shared server state.
 * @param now Clock, for the age check.
 * @returns Whether the next `pre_action_check` call must be refused.
 */
export function hasUnverifiedDecision(context: ServerContext, now: number): boolean {
  if (context.config.mode !== 'enforced') {
    return false
  }
  const last = context.lastIssued
  if (last === null) {
    return false
  }
  if (now - last.at > ENFORCEMENT_WINDOW_MS) {
    return false
  }
  // A peek rather than a consume: this check must not spend the nonce, because
  // the agent still needs to be able to verify it.
  const entry = context.nonces.peek(last.nonce)
  return entry === null || !entry.consumed
}
