/**
 * Sliding-window rate limiting.
 *
 * The purpose is to stop a runaway agent loop from hammering the engine, and to
 * bound the cost of a session that retries a failing reproduction. A fixed
 * window would let a caller send 2x the budget across a window boundary, so this
 * counts events over a rolling interval instead.
 *
 * There is deliberately no distributed state and no persistence. One MCP server
 * process serves one host, and a rate limit that resets on restart is fine: the
 * thing being bounded is a loop within a session, not an attacker.
 */

import type { RateLimitOptions } from './types.js'

/** Defaults, matching the documented configuration. */
export const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, max: 20 }

/** One recorded request. */
interface Hit {
  at: number
}

/** Outcome of asking the limiter for permission. */
export interface RateLimitVerdict {
  /** Whether the request is within budget. */
  allowed: boolean
  /** Requests observed inside the current window, including this one. */
  count: number
  /** The window in force, in milliseconds. */
  windowMs: number
  /** The budget in force. */
  max: number
}

/**
 * A rolling-window counter for a single bucket.
 *
 * Hits are kept as a list of timestamps rather than a count, because a count
 * cannot answer "how many are still in the window" once old entries must expire.
 * The list is short by construction: it only ever holds entries newer than the
 * window, so it is bounded by the number of requests actually made in that
 * period, and is pruned on every check.
 */
export class SlidingWindowLimiter {
  readonly #windowMs: number
  readonly #max: number
  #hits: Hit[] = []

  /**
   * @param options Budget and window. Unset fields use the documented defaults.
   * @param now Clock injection point for tests.
   */
  constructor(
    options: Partial<RateLimitOptions> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.#windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT.windowMs
    this.#max = options.max ?? DEFAULT_RATE_LIMIT.max
  }

  /** The window currently in force. */
  get windowMs(): number {
    return this.#windowMs
  }

  /** The budget currently in force. */
  get max(): number {
    return this.#max
  }

  /** Hits currently inside the window, for diagnostics. */
  get count(): number {
    this.prune()
    return this.#hits.length
  }

  /**
   * Records a request and reports whether it is within budget.
   *
   * A rejected request is still counted. Otherwise a caller that keeps retrying
   * would never be throttled, since only accepted requests would advance the
   * window.
   *
   * @returns Whether the request is allowed, plus the numbers behind the answer.
   */
  check(): RateLimitVerdict {
    const at = this.now()
    this.prune()
    this.#hits.push({ at })

    const count = this.#hits.length
    return {
      allowed: count <= this.#max,
      count,
      windowMs: this.#windowMs,
      max: this.#max,
    }
  }

  /** Forgets every recorded hit. */
  reset(): void {
    this.#hits = []
  }

  /** Drops hits that have fallen out of the rolling window. */
  private prune(): void {
    const cutoff = this.now() - this.#windowMs
    // Hits are appended in time order, so the expired ones are always a prefix.
    let drop = 0
    while (drop < this.#hits.length) {
      const hit = this.#hits[drop]
      if (hit === undefined || hit.at > cutoff) {
        break
      }
      drop += 1
    }
    if (drop > 0) {
      this.#hits = this.#hits.slice(drop)
    }
  }
}
