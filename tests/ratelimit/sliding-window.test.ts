/**
 * Sliding-window rate limiter tests.
 *
 * A fake clock rather than real timers: the behaviour under test is entirely
 * about time arithmetic, and a real clock would make these tests slow and flaky
 * while testing less.
 */

import { describe, expect, it } from 'vitest'

import { SlidingWindowLimiter } from '../../src/ratelimit/sliding-window.js'

/** A clock the test moves by hand. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('SlidingWindowLimiter', () => {
  it('allows requests up to the budget', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 3, windowMs: 1000 }, clock.now)

    expect(limiter.check().allowed).toBe(true)
    expect(limiter.check().allowed).toBe(true)
    expect(limiter.check().allowed).toBe(true)
  })

  it('refuses the request that exceeds the budget', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 3, windowMs: 1000 }, clock.now)

    for (let i = 0; i < 3; i += 1) {
      limiter.check()
    }

    const verdict = limiter.check()
    expect(verdict.allowed).toBe(false)
    expect(verdict.count).toBe(4)
    expect(verdict.max).toBe(3)
    expect(verdict.windowMs).toBe(1000)
  })

  it('counts refused requests, so a retry loop cannot outrun the budget', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 2, windowMs: 1000 }, clock.now)

    limiter.check()
    limiter.check()
    const third = limiter.check()
    const fourth = limiter.check()

    expect(third.allowed).toBe(false)
    // Still refused, and the count keeps climbing. If only accepted requests
    // were counted, a retrying caller would never be throttled.
    expect(fourth.allowed).toBe(false)
    expect(fourth.count).toBe(4)
  })

  it('lets requests through again once the window slides', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 2, windowMs: 1000 }, clock.now)

    limiter.check()
    limiter.check()
    expect(limiter.check().allowed).toBe(false)

    clock.advance(1001)

    expect(limiter.check().allowed).toBe(true)
  })

  it('slides gradually rather than resetting at a boundary', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 2, windowMs: 1000 }, clock.now)

    limiter.check() // t = 0
    clock.advance(1100)
    // The t=0 hit is now older than the window and has aged out on its own. A
    // fixed window would have reset all at once instead.
    const verdict = limiter.check()

    expect(limiter.count).toBe(1)
    expect(verdict.allowed).toBe(true)
  })

  it('keeps a hit that is still inside the window', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 3, windowMs: 1000 }, clock.now)

    limiter.check() // t = 0
    clock.advance(900)
    limiter.check() // t = 900, so both hits are still live

    expect(limiter.count).toBe(2)
  })

  it('defaults to 20 per 60s', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({}, clock.now)

    expect(limiter.max).toBe(20)
    expect(limiter.windowMs).toBe(60_000)

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.check().allowed).toBe(true)
    }
    expect(limiter.check().allowed).toBe(false)
  })

  it('resets on demand', () => {
    const clock = fakeClock()
    const limiter = new SlidingWindowLimiter({ max: 1, windowMs: 1000 }, clock.now)
    limiter.check()
    expect(limiter.check().allowed).toBe(false)

    limiter.reset()

    expect(limiter.check().allowed).toBe(true)
  })
})
