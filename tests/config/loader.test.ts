/**
 * Config loader tests.
 *
 * The search order is the part with a real failure mode: getting it wrong means
 * a user edits one file and a different one takes effect. Every test therefore
 * checks which file won, not just what came out.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ConfigError,
  DEFAULT_CONFIG,
  candidateConfigPaths,
  loadConfig,
  parseConfigFile,
} from '../../src/config/loader.js'

/** Creates a temp directory that will be cleaned up by the OS. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gk-config-'))
}

/** Writes a config file into a directory and returns its path. */
function writeConfig(dir: string, name: string, body: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return path
}

describe('candidateConfigPaths', () => {
  it('orders env override, then cwd, then home', () => {
    const cwd = tempDir()
    const home = tempDir()
    const envPath = writeConfig(cwd, 'override.json', {})
    const cwdPath = writeConfig(cwd, '.gatekeeperrc.json', {})
    const homePath = writeConfig(home, '.gatekeeperrc.json', {})

    const found = candidateConfigPaths(cwd, home, { GATEKEEPER_CONFIG: envPath })

    expect(found).toEqual([envPath, cwdPath, homePath])
  })

  it('omits sources that do not exist', () => {
    const cwd = tempDir()
    const home = tempDir()

    expect(candidateConfigPaths(cwd, home, {})).toEqual([])
  })
})

describe('loadConfig', () => {
  it('applies defaults when no file exists', () => {
    const { config, source } = loadConfig({ cwd: tempDir(), home: tempDir(), env: {} })

    expect(source).toBeNull()
    expect(config.mode).toBe('advisory')
    expect(config.rateLimit).toEqual({ windowMs: 60_000, max: 20 })
    expect(config.nonceStore).toEqual({ maxSize: 1000, ttlMs: 300_000 })
  })

  it('prefers the cwd file over the home file', () => {
    const cwd = tempDir()
    const home = tempDir()
    writeConfig(cwd, '.gatekeeperrc.json', { mode: 'enforced' })
    writeConfig(home, '.gatekeeperrc.json', { mode: 'advisory' })

    const { config, source } = loadConfig({ cwd, home, env: {} })

    expect(config.mode).toBe('enforced')
    expect(source).toBe(join(cwd, '.gatekeeperrc.json'))
  })

  it('prefers GATEKEEPER_CONFIG over the cwd file', () => {
    const cwd = tempDir()
    const home = tempDir()
    const override = writeConfig(tempDir(), 'custom.json', { mode: 'enforced' })
    writeConfig(cwd, '.gatekeeperrc.json', { mode: 'advisory' })

    const { config, source } = loadConfig({ cwd, home, env: { GATEKEEPER_CONFIG: override } })

    expect(config.mode).toBe('enforced')
    expect(source).toBe(override)
  })

  it('throws on invalid JSON rather than falling back to defaults', () => {
    const cwd = tempDir()
    writeConfig(cwd, '.gatekeeperrc.json', '{ not json')

    // A quiet fallback here would silently revert a user's enforced mode to
    // advisory, which is the exact class of downgrade this project prevents.
    expect(() => loadConfig({ cwd, home: tempDir(), env: {} })).toThrow(ConfigError)
  })

  it('throws on a schema violation, naming the offending key', () => {
    const cwd = tempDir()
    writeConfig(cwd, '.gatekeeperrc.json', { mode: 'sideways' })

    expect(() => loadConfig({ cwd, home: tempDir(), env: {} })).toThrow(/mode/)
  })

  it('rejects unknown fields, so a typo is not silently ignored', () => {
    const cwd = tempDir()
    writeConfig(cwd, '.gatekeeperrc.json', { modeee: 'enforced' })

    expect(() => loadConfig({ cwd, home: tempDir(), env: {} })).toThrow(/modeee/)
  })

  it('accepts a partial file and fills the rest from defaults', () => {
    const cwd = tempDir()
    writeConfig(cwd, '.gatekeeperrc.json', { rateLimit: { max: 5 } })

    const { config } = loadConfig({ cwd, home: tempDir(), env: {} })

    expect(config.rateLimit.max).toBe(5)
    expect(config.rateLimit.windowMs).toBe(60_000)
    expect(config.mode).toBe('advisory')
  })

  it('round-trips the documented denylist shape', () => {
    const cwd = tempDir()
    writeConfig(cwd, '.gatekeeperrc.json', {
      denylist: { commands: ['rm'], patterns: ['curl.*\\|.*sh'] },
    })

    const { config } = loadConfig({ cwd, home: tempDir(), env: {} })

    expect(config.denylist.commands).toEqual(['rm'])
    expect(config.denylist.patterns).toEqual(['curl.*\\|.*sh'])
  })
})

describe('parseConfigFile', () => {
  it('accepts an injected reader, so no file is needed on disk', () => {
    const config = parseConfigFile('/nowhere.json', () => '{"mode":"enforced"}')

    expect(config.mode).toBe('enforced')
  })

  it('throws when the injected reader fails', () => {
    expect(() =>
      parseConfigFile('/nowhere.json', () => {
        throw new Error('boom')
      }),
    ).toThrow(ConfigError)
  })
})

describe('DEFAULT_CONFIG', () => {
  it('keeps the audit log off unless a user asks for it', () => {
    // Writing a file the user never requested would be surprising, and ADR 0005
    // treats unexpected local writes as a problem.
    expect(DEFAULT_CONFIG.auditLog.enabled).toBe(false)
  })
})
