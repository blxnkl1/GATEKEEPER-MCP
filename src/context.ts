/**
 * Server-scoped state shared by the tools.
 *
 * The nonce store, rate limiter, audit log, and configuration all need to
 * outlive a single tool call but die with the process. Rather than threading
 * them through every registration signature, the tools close over one context
 * object created in `createServer()`. That also makes them trivial to test: a
 * test constructs a context with fakes and hands it to the registration
 * function.
 */

import { AuditLog } from './audit/audit-log.js'
import type { Config } from './config/loader.js'
import { SlidingWindowLimiter } from './ratelimit/sliding-window.js'
import { NonceStore } from './store/nonce-store.js'

/** Everything the tools share for the lifetime of one server. */
export interface ServerContext {
  config: Config
  nonces: NonceStore
  limiter: SlidingWindowLimiter
  /**
   * Separate budget for `verify_decision`.
   *
   * Kept apart from {@link limiter} on purpose. Enforced mode refuses a new
   * `pre_action_check` while the previous decision is unverified, so every
   * legitimate verification has to fit in the budget *between* two checks; if
   * the two shared one window, a burst of checks could lock an agent out of the
   * very call it needs in order to make progress.
   */
  verifyLimiter: SlidingWindowLimiter
  audit: AuditLog
  /**
   * The most recent nonce this server issued, and whether it was verified.
   *
   * Enforced mode needs to know whether the previous decision was ever checked,
   * which is a sequence property and does not belong in the nonce store itself.
   */
  lastIssued: { nonce: string; decision: 'allow' | 'deny' | 'request_info'; at: number } | null
}

/** How long an issued decision stays "current" for enforced mode. */
export const ENFORCEMENT_WINDOW_MS = 60_000

/**
 * Default budget for `verify_decision`, relative to the check budget.
 *
 * Verification is a single map lookup, so it is cheap, but it is also
 * unauthenticated and appends to the audit log. Ten times the check budget is
 * enough headroom for any real conversation while still bounding a loop.
 */
export const VERIFY_RATE_MULTIPLIER = 10

/**
 * Builds a context from a resolved configuration.
 *
 * @param config The loaded configuration.
 * @param overrides Test seams for the clock and the store.
 * @returns A ready context.
 */
export function createServerContext(
  config: Config,
  overrides: { now?: () => number; nonces?: NonceStore } = {},
): ServerContext {
  return {
    config,
    nonces: overrides.nonces ?? new NonceStore(config.nonceStore),
    limiter: new SlidingWindowLimiter(config.rateLimit, overrides.now),
    verifyLimiter: new SlidingWindowLimiter(
      { windowMs: config.rateLimit.windowMs, max: config.rateLimit.max * VERIFY_RATE_MULTIPLIER },
      overrides.now,
    ),
    audit: new AuditLog({
      enabled: config.auditLog.enabled,
      path: config.auditLog.path,
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
    }),
    lastIssued: null,
  }
}
