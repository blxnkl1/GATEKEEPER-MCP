/**
 * Single-use tokens for the anti-fabrication mechanism.
 *
 * Every `pre_action_check` reply carries a nonce. If the agent then claims a
 * different decision to the user, `verify_decision` compares the claim against
 * what was actually issued and the mismatch is recorded. A nonce is therefore
 * the evidence that a reported decision came from this server rather than from
 * the model's imagination.
 *
 * Bounded on purpose. An agent in a loop must not be able to grow this without
 * limit, and an MCP session is short-lived, so a few thousand entries is far more
 * than any real conversation needs.
 */

import { randomBytes } from 'node:crypto'

/** One issued nonce and what it entitles the caller to claim. */
export interface NonceEntry {
  /** The opaque token handed to the agent. */
  nonce: string
  /** The decision this server actually returned. */
  decision: 'allow' | 'deny' | 'request_info'
  /** Wall-clock issue time, from `Date.now()`. */
  issuedAt: number
  /** Whether `verify_decision` has already spent this nonce. */
  consumed: boolean
}

/** What `consume` hands back on a successful lookup. */
export interface ConsumedNonce {
  decision: 'allow' | 'deny' | 'request_info'
}

/** Store configuration. */
export interface NonceStoreOptions {
  /** Maximum entries retained. Oldest are evicted first. Default 1000. */
  maxSize?: number
  /** Entries older than this are swept. Default 300000 (5 minutes). */
  ttlMs?: number
}

/** Defaults, matching the documented configuration. */
export const DEFAULT_NONCE_STORE_OPTIONS = { maxSize: 1000, ttlMs: 300_000 } as const

/**
 * Generates a nonce.
 *
 * 16 random bytes in base64url gives 22 URL-safe characters, which is safe to
 * embed in JSON, a shell argument, or a URL without escaping. `randomBytes` is
 * a CSPRNG: the nonce is the only thing standing between an audit trail and an
 * agent that guesses tokens, so a predictable source would defeat the point.
 *
 * @returns A fresh nonce.
 */
export function generateNonce(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * A bounded, self-sweeping set of issued nonces.
 *
 * Insertion order is preserved by `Map`, so the oldest entry is the first key
 * and eviction is a single delete rather than a scan.
 */
export class NonceStore {
  readonly #entries = new Map<string, NonceEntry>()
  readonly #maxSize: number
  readonly #ttlMs: number

  /** @param options Store limits. Unset fields use the documented defaults. */
  constructor(options: NonceStoreOptions = {}) {
    this.#maxSize = options.maxSize ?? DEFAULT_NONCE_STORE_OPTIONS.maxSize
    this.#ttlMs = options.ttlMs ?? DEFAULT_NONCE_STORE_OPTIONS.ttlMs
  }

  /** Number of entries currently held, consumed ones included. */
  get size(): number {
    return this.#entries.size
  }

  /**
   * Records a nonce and the decision it authorises.
   *
   * Sweeping happens here rather than on a timer: an MCP server may live for
   * minutes or hours, and a background interval would keep the process alive and
   * burn a wakeup per tick to clean up a map that only changes on a tool call.
   *
   * @param nonce The token, normally from {@link generateNonce}.
   * @param decision The decision actually returned to the agent.
   */
  issue(nonce: string, decision: NonceEntry['decision']): void {
    this.sweep()

    // Re-inserting an existing key would keep its original position, which would
    // make the eviction order wrong. Delete first so it moves to newest.
    this.#entries.delete(nonce)
    this.#entries.set(nonce, { nonce, decision, issuedAt: Date.now(), consumed: false })

    while (this.#entries.size > this.#maxSize) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) {
        break
      }
      this.#entries.delete(oldest.value)
    }
  }

  /**
   * Looks up a nonce and marks it spent.
   *
   * A nonce is single use. Spending it on the first successful lookup is what
   * makes a replay detectable, and replay is the obvious way to launder one real
   * decision into many claims.
   *
   * @param nonce The token the agent presented.
   * @returns The recorded decision, or null when unknown, expired, or spent.
   */
  consume(nonce: string): ConsumedNonce | null {
    const entry = this.#entries.get(nonce)

    if (entry === undefined) {
      return null
    }
    if (entry.consumed) {
      return null
    }
    if (Date.now() - entry.issuedAt > this.#ttlMs) {
      this.#entries.delete(nonce)
      return null
    }

    entry.consumed = true
    return { decision: entry.decision }
  }

  /**
   * Reads a nonce without spending it.
   *
   * Used by the enforced-mode sequence check, which needs to know whether the
   * previous decision was ever verified but must not spend it in the process.
   *
   * @param nonce The token to inspect.
   * @returns A copy of the entry, or null when unknown or expired.
   */
  peek(nonce: string): NonceEntry | null {
    const entry = this.#entries.get(nonce)
    if (entry === undefined) {
      return null
    }
    if (Date.now() - entry.issuedAt > this.#ttlMs) {
      this.#entries.delete(nonce)
      return null
    }
    return { ...entry }
  }

  /** Drops every entry older than the TTL. Safe to call at any time. */
  sweep(): void {
    const cutoff = Date.now() - this.#ttlMs
    for (const [nonce, entry] of this.#entries) {
      if (entry.issuedAt < cutoff) {
        this.#entries.delete(nonce)
      }
    }
  }

  /** Empties the store. Used by tests and by a config reload. */
  clear(): void {
    this.#entries.clear()
  }
}
