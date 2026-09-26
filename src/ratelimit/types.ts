/**
 * Shared configuration types.
 *
 * Kept in their own module so the rate limiter and the audit log can depend on
 * the shape without importing the loader, which reads the filesystem at load time
 * and would make them untestable in isolation.
 */

/** Sliding-window request budget. */
export interface RateLimitOptions {
  /** Rolling window length in milliseconds. */
  windowMs: number
  /** Requests permitted inside one window. */
  max: number
}
