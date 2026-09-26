/**
 * Nonce store tests.
 *
 * The store is the evidentiary basis for the anti-fabrication mechanism, so the
 * properties that matter are the adversarial ones: a spent nonce cannot be
 * replayed, an old nonce expires, and the store cannot grow without bound.
 */

import { describe, expect, it } from 'vitest'

import { NonceStore, generateNonce } from '../../src/store/nonce-store.js'

describe('generateNonce', () => {
  it('produces 22 URL-safe base64url characters', () => {
    const nonce = generateNonce()

    expect(nonce).toHaveLength(22)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('produces a different value every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateNonce()))

    expect(seen.size).toBe(200)
  })
})

describe('NonceStore', () => {
  it('returns the issued decision for a known nonce', () => {
    const store = new NonceStore()
    store.issue('n1', 'deny')

    expect(store.consume('n1')).toEqual({ decision: 'deny' })
  })

  it('returns null for an unknown nonce', () => {
    const store = new NonceStore()

    expect(store.consume('never-issued')).toBeNull()
  })

  it('rejects a replayed nonce', () => {
    const store = new NonceStore()
    store.issue('n1', 'allow')

    expect(store.consume('n1')).toEqual({ decision: 'allow' })
    // Single use is the whole point: one real decision must not be laundered into
    // many claims.
    expect(store.consume('n1')).toBeNull()
  })

  it('expires entries older than the TTL', async () => {
    const store = new NonceStore({ ttlMs: 20 })
    store.issue('n1', 'deny')

    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(store.consume('n1')).toBeNull()
  })

  it('sweeps expired entries on issue, without a timer', async () => {
    const store = new NonceStore({ ttlMs: 20, maxSize: 100 })
    store.issue('old', 'deny')

    await new Promise((resolve) => setTimeout(resolve, 40))
    store.issue('new', 'allow')

    // The expired entry is gone, so the store holds one entry rather than two.
    expect(store.size).toBe(1)
    expect(store.consume('old')).toBeNull()
    expect(store.consume('new')).toEqual({ decision: 'allow' })
  })

  it('evicts the oldest entry when over capacity', () => {
    const store = new NonceStore({ maxSize: 3 })
    store.issue('a', 'deny')
    store.issue('b', 'deny')
    store.issue('c', 'deny')
    store.issue('d', 'deny')

    expect(store.size).toBe(3)
    expect(store.consume('a')).toBeNull()
    expect(store.consume('d')).toEqual({ decision: 'deny' })
  })

  it('peeks without consuming', () => {
    const store = new NonceStore()
    store.issue('n1', 'request_info')

    expect(store.peek('n1')).toMatchObject({ decision: 'request_info', consumed: false })
    // Still spendable, which is what enforced mode relies on.
    expect(store.consume('n1')).toEqual({ decision: 'request_info' })
  })

  it('returns null from peek for an unknown nonce', () => {
    expect(new NonceStore().peek('missing')).toBeNull()
  })

  it('re-issuing a nonce moves it to newest so eviction order stays correct', () => {
    const store = new NonceStore({ maxSize: 2 })
    store.issue('a', 'deny')
    store.issue('b', 'deny')
    store.issue('a', 'allow')

    // 'a' was re-issued, so 'b' is now the oldest and is the one evicted.
    store.issue('c', 'deny')

    expect(store.consume('b')).toBeNull()
    expect(store.consume('a')).toEqual({ decision: 'allow' })
  })

  it('clears every entry', () => {
    const store = new NonceStore()
    store.issue('a', 'deny')
    store.issue('b', 'deny')

    store.clear()

    expect(store.size).toBe(0)
  })
})
