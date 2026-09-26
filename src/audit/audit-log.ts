/**
 * Append-only local audit log.
 *
 * Every decision the server reaches is recorded as one JSON object per line, so
 * a disputed outcome can be settled after the fact from the log rather than from
 * anyone's memory, including the model's. This is the ground truth for an
 * anti-fabrication dispute: if the log says the server issued `deny` and the
 * agent reported `allow`, the log wins and `fabrication_suspected` exists to make
 * that difference queryable.
 *
 * Two properties are load-bearing. It is strictly local, per
 * ADR 0005, and it never writes raw user input: `taskDescription` is stored as a
 * truncated hash, because a log that quietly accumulates the contents of every
 * prompt is a privacy problem disguised as a diagnostic.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { logger } from '../logger.js'

/** The event kinds the log records. */
export type AuditEvent =
  | 'pre_action_check'
  | 'verify_decision'
  | 'rate_limit_exceeded'
  | 'denylist_rejected'
  | 'fabrication_suspected'

/** Fields present on every record. */
interface AuditRecordBase {
  /** ISO timestamp, so a log is readable without tooling. */
  ts: string
  event: AuditEvent
}

/** One recorded decision. */
export interface PreActionCheckRecord extends AuditRecordBase {
  event: 'pre_action_check'
  nonce: string
  decision: string
  /** First 8 hex characters of sha256(taskDescription). Never the raw text. */
  taskHash: string
}

/** One verification attempt. */
export interface VerifyDecisionRecord extends AuditRecordBase {
  event: 'verify_decision'
  nonce: string
  valid: boolean
  claimed: string
  issued: string | null
}

/** A request refused by the rate limiter. */
export interface RateLimitRecord extends AuditRecordBase {
  event: 'rate_limit_exceeded'
  count: number
  windowMs: number
  max: number
}

/** A command refused by the denylist. */
export interface DenylistRecord extends AuditRecordBase {
  event: 'denylist_rejected'
  command: string
}

/** A claim that contradicted an issued decision. */
export interface FabricationRecord extends AuditRecordBase {
  event: 'fabrication_suspected'
  nonce: string
  claimed: string
  actual: string
}

/** Any record the log can hold. */
export type AuditEntry =
  | PreActionCheckRecord
  | VerifyDecisionRecord
  | RateLimitRecord
  | DenylistRecord
  | FabricationRecord

/**
 * `Omit` that distributes over a union.
 *
 * The built-in `Omit` is not distributive: applied to a union it collapses the
 * union down to the keys its members share, which would erase the per-event
 * fields and make every call site fail to typecheck. Distributing first keeps
 * each variant's own fields, so a call site is checked against its real event.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What a caller supplies: the event and its fields, minus the timestamp. */
export type AuditWrite = DistributiveOmit<AuditEntry, 'ts'>

/** Audit log configuration. */
export interface AuditLogOptions {
  /** When false, every write is a no-op. Stderr logging is unaffected. */
  enabled?: boolean
  /** Absolute path to the log file. */
  path?: string
  /** Rotate once the file exceeds this many bytes. Default 10 MB. */
  maxBytes?: number
  /** Clock injection point for tests. */
  now?: () => number
}

/** Defaults, matching the documented configuration. */
export const DEFAULT_AUDIT_OPTIONS = {
  enabled: false,
  maxBytes: 10 * 1024 * 1024,
} as const

/**
 * Truncates a task description to a stable, non-reversible fingerprint.
 *
 * Eight hex characters of SHA-256 is enough to tell two calls apart in a log and
 * far too little to reconstruct a prompt from. A log that stored the text would
 * accumulate whatever the agent was asked to do, which is exactly the kind of
 * quiet data collection ADR 0005 rules out.
 *
 * @param text The task description, or any other free text.
 * @returns Eight lowercase hex characters.
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8)
}

/**
 * A single-file append-only log with one-generation rotation.
 *
 * One generation rather than a numbered set: a rotation scheme that keeps ten
 * files is a disk-usage policy, and this is a diagnostic aid whose entire value
 * is in the recent past.
 */
export class AuditLog {
  readonly #enabled: boolean
  readonly #path: string
  readonly #maxBytes: number
  readonly #now: () => number

  /** @param options Enable flag, path, rotation threshold, and clock. */
  constructor(options: AuditLogOptions = {}) {
    this.#enabled = options.enabled ?? DEFAULT_AUDIT_OPTIONS.enabled
    this.#path = options.path ?? ''
    this.#maxBytes = options.maxBytes ?? DEFAULT_AUDIT_OPTIONS.maxBytes
    this.#now = options.now ?? (() => Date.now())
  }

  /** Whether writes are recorded. */
  get enabled(): boolean {
    return this.#enabled
  }

  /** Absolute path of the active log file. */
  get path(): string {
    return this.#path
  }

  /**
   * Appends one entry.
   *
   * Never throws. An audit log that can take down the server is worse than no
   * audit log, because it turns a disk or permission problem into an outage of
   * the thing being audited. A failure is reported on stderr and swallowed.
   *
   * @param entry The record to write, without the timestamp.
   */
  write(entry: AuditWrite): void {
    if (!this.#enabled || this.#path === '') {
      return
    }

    const record = { ts: new Date(this.#now()).toISOString(), ...entry }
    const line = `${JSON.stringify(record)}\n`

    try {
      this.rotateIfNeeded(Buffer.byteLength(line))
      mkdirSync(dirname(this.#path), { recursive: true })
      appendFileSync(this.#path, line, 'utf8')
    } catch (error) {
      logger.error(
        { err: error, auditPath: this.#path },
        'audit: could not append to the audit log',
      )
    }
  }

  /**
   * Rotates when the file would exceed the threshold.
   *
   * The rotated file is always overwritten, so exactly one previous generation
   * survives and the directory cannot grow without bound.
   */
  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.#path)) {
      return
    }
    const size = statSync(this.#path).size
    if (size + incomingBytes <= this.#maxBytes) {
      return
    }
    const rotated = `${this.#path}.1`
    if (existsSync(rotated)) {
      // Exactly one generation is kept, so the old one is discarded.
      writeFileSync(rotated, '')
    }
    renameSync(this.#path, rotated)
  }
}
