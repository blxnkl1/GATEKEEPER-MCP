/**
 * Audit log tests.
 *
 * The property that matters most is that raw user input never reaches the disk.
 * A log that quietly accumulates every prompt would be a privacy problem wearing
 * a diagnostic's clothes, and ADR 0005 treats exactly that as unacceptable.
 */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AuditLog, hashText } from '../../src/audit/audit-log.js'

/** A temp directory and a log path inside it. */
function tempLog(name = 'audit.log'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gk-audit-'))
  return { dir, path: join(dir, name) }
}

/** Parses a log file into objects, tolerating absence. */
function readLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return []
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('hashText', () => {
  it('returns eight hex characters', () => {
    expect(hashText('anything')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is stable for the same input and differs across inputs', () => {
    expect(hashText('same')).toBe(hashText('same'))
    expect(hashText('a')).not.toBe(hashText('b'))
  })
})

describe('AuditLog', () => {
  it('writes nothing when disabled', () => {
    const { path } = tempLog()
    const log = new AuditLog({ enabled: false, path })

    log.write({ event: 'pre_action_check', nonce: 'n', decision: 'deny', taskHash: 'abc12345' })

    expect(existsSync(path)).toBe(false)
  })

  it('appends one JSON object per line', () => {
    const { path } = tempLog()
    const log = new AuditLog({ enabled: true, path })

    log.write({ event: 'pre_action_check', nonce: 'n1', decision: 'deny', taskHash: 'abc12345' })
    log.write({
      event: 'verify_decision',
      nonce: 'n1',
      valid: true,
      claimed: 'deny',
      issued: 'deny',
    })

    const lines = readLines(path)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.event).toBe('pre_action_check')
    expect(lines[1]?.event).toBe('verify_decision')
  })

  it('stamps every record with an ISO timestamp', () => {
    const { path } = tempLog()
    new AuditLog({ enabled: true, path, now: () => 1_700_000_000_000 }).write({
      event: 'rate_limit_exceeded',
      count: 21,
      windowMs: 60_000,
      max: 20,
    })

    expect(readLines(path)[0]?.ts).toBe('2023-11-14T22:13:20.000Z')
  })

  it('never stores raw task text', () => {
    const { path } = tempLog()
    const log = new AuditLog({ enabled: true, path })
    const secret = 'refactor the auth bypass in production'

    log.write({
      event: 'pre_action_check',
      nonce: 'n',
      decision: 'deny',
      taskHash: hashText(secret),
    })

    const contents = readFileSync(path, 'utf8')
    expect(contents).not.toContain('auth bypass')
    expect(contents).toContain(hashText(secret))
  })

  it('rotates at the threshold, keeping one previous generation', () => {
    const { path } = tempLog()
    writeFileSync(path, '', 'utf8')
    // A tiny threshold so the test does not need megabytes of filler.
    const log = new AuditLog({ enabled: true, path, maxBytes: 10 })

    log.write({ event: 'denylist_rejected', command: 'rm' })
    log.write({ event: 'denylist_rejected', command: 'dd' })

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(statSync(path).size).toBeLessThan(200)
    // Exactly one generation, so the directory cannot grow without bound.
    expect(existsSync(`${path}.2`)).toBe(false)
  })

  it('overwrites the rotated file rather than accumulating generations', () => {
    const { path } = tempLog()
    const log = new AuditLog({ enabled: true, path, maxBytes: 5 })
    writeFileSync(path, 'x'.repeat(50), 'utf8')

    log.write({ event: 'denylist_rejected', command: 'rm' })
    const firstRotation = readFileSync(`${path}.1`, 'utf8')
    log.write({ event: 'denylist_rejected', command: 'dd' })

    expect(readFileSync(`${path}.1`, 'utf8')).not.toBe(firstRotation)
  })

  it('swallows write failures rather than throwing into the caller', () => {
    // A directory path is not a file, so the write cannot succeed.
    const dir = mkdtempSync(join(tmpdir(), 'gk-audit-'))
    const log = new AuditLog({ enabled: true, path: dir })

    expect(() => log.write({ event: 'denylist_rejected', command: 'rm' })).not.toThrow()
  })

  it('creates the parent directory on demand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gk-audit-'))
    const path = join(dir, 'nested', 'deeper', 'audit.log')
    const log = new AuditLog({ enabled: true, path })

    log.write({ event: 'denylist_rejected', command: 'rm' })

    expect(existsSync(path)).toBe(true)
  })
})
