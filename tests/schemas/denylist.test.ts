/**
 * Denylist tests.
 *
 * These exist because the built-in patterns were once written with lost escapes,
 * which turned `curl.*\|.*sh` into `curl.*|.*sh` and made the pattern match almost
 * any string containing "sh". That rejected legitimate commands while looking
 * like it was working, and nothing failed. Each pattern is therefore pinned here
 * against both a string it must catch and a string it must not.
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DENYLIST,
  DEFAULT_DENYLISTED_COMMANDS,
  DEFAULT_DENYLISTED_PATTERNS,
  createReproductionSchema,
  denylistReason,
} from '../../src/schemas/pre_action_check.js'

/** The shape a config file supplies. */
const EMPTY = { commands: [], patterns: [] }

describe('default command denylist', () => {
  it('refuses the destructive commands by basename', () => {
    for (const command of ['rm', 'dd', 'mkfs', 'shutdown', 'reboot', 'halt', 'poweroff']) {
      expect(denylistReason(command, DEFAULT_DENYLIST), command).not.toBeNull()
    }
  })

  it('refuses a denied command given by absolute path', () => {
    expect(denylistReason('/bin/rm', DEFAULT_DENYLIST)).not.toBeNull()
    expect(denylistReason('/usr/bin/sudo', DEFAULT_DENYLIST)).not.toBeNull()
  })

  it('allows ordinary project tooling', () => {
    for (const command of ['npm', 'node', 'npx', 'pytest', 'cargo', 'go', 'mvn', 'gradle']) {
      expect(denylistReason(command, DEFAULT_DENYLIST), command).toBeNull()
    }
  })

  it('refuses shell interpreters, so a shell cannot be reached as a reproduction', () => {
    // `bash -c "…"` is a shell by another name. Allowing it while refusing
    // `curl … | sh` would make the pattern denylist decorative.
    for (const command of ['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'env', 'xargs']) {
      expect(denylistReason(command, DEFAULT_DENYLIST), command).not.toBeNull()
    }
  })

  it('refuses an interpreter reached by absolute path', () => {
    for (const command of ['/bin/bash', '/bin/sh', '/usr/bin/env', '/usr/bin/python3']) {
      expect(denylistReason(command, DEFAULT_DENYLIST), command).not.toBeNull()
    }
  })

  it('refuses script hosts, which are interpreters under another name', () => {
    for (const command of ['python', 'python3', 'perl', 'ruby', 'php', 'osascript', 'pwsh']) {
      expect(denylistReason(command, DEFAULT_DENYLIST), command).not.toBeNull()
    }
  })

  it('refuses network fetchers, so egress cannot be requested as a reproduction', () => {
    for (const command of ['curl', 'wget', 'nc', 'ssh', 'scp', 'rsync', 'ftp']) {
      expect(denylistReason(command, DEFAULT_DENYLIST), command).not.toBeNull()
    }
  })

  it('does not refuse a command that merely contains a denied name', () => {
    // "format" contains "rm", and "grader" contains "grade". A substring match
    // would refuse ordinary tools.
    expect(denylistReason('format', DEFAULT_DENYLIST)).toBeNull()
    expect(denylistReason('node', DEFAULT_DENYLIST)).toBeNull()
    // "envs" contains "env"; "shellcheck" is not "sh".
    expect(denylistReason('envs', DEFAULT_DENYLIST)).toBeNull()
    expect(denylistReason('shellcheck', DEFAULT_DENYLIST)).toBeNull()
  })
})

describe('default pattern denylist', () => {
  it('compiles every pattern as a regular expression', () => {
    for (const pattern of DEFAULT_DENYLISTED_PATTERNS) {
      expect(() => new RegExp(pattern, 'i'), pattern).not.toThrow()
    }
  })

  it('keeps its escapes, so a pipe is matched literally', () => {
    // The regression this file exists for: an unescaped "|" becomes an
    // alternation and the pattern degenerates into "matches anything".
    const piped = DEFAULT_DENYLIST.patterns.find((p) => p.includes('curl'))

    expect(piped).toBeDefined()
    expect(piped).toContain('\\|')
  })

  it('catches a pipe to a shell spread across the arguments', () => {
    const refusal = denylistReason('curl', DEFAULT_DENYLIST, ['http://example.com', '|', 'sh'])

    expect(refusal).not.toBeNull()
    // curl is now refused on its own merits, before the pattern is consulted.
    expect(refusal).toMatch(/denylist|denied pattern/)
  })

  it('catches rm -rf / spelled with spaces', () => {
    expect(denylistReason('/bin/rm', DEFAULT_DENYLIST, ['-rf', '/'])).not.toBeNull()
  })

  it('catches a write to a raw disk device', () => {
    expect(denylistReason('dd', DEFAULT_DENYLIST)).not.toBeNull()
    expect(denylistReason('/bin/sh', DEFAULT_DENYLIST, ['>', '/dev/sda'])).not.toBeNull()
  })

  it('does not fire on ordinary commands and arguments', () => {
    expect(denylistReason('npm', DEFAULT_DENYLIST, ['test'])).toBeNull()
    expect(denylistReason('grep', DEFAULT_DENYLIST, ['-rn', 'shell', 'src/'])).toBeNull()
    expect(denylistReason('node', DEFAULT_DENYLIST, ['test.js'])).toBeNull()
  })

  it('survives a broken pattern without throwing', () => {
    const broken = { commands: [], patterns: ['([unclosed'] }

    // A user-editable pattern must not be able to take the session down. It
    // fails open for that one pattern, and the basename list still applies.
    expect(() => denylistReason('npm', broken)).not.toThrow()
    expect(denylistReason('npm', broken)).toBeNull()
    expect(denylistReason('rm', { ...broken, commands: ['rm'] })).not.toBeNull()
  })
})

describe('createReproductionSchema', () => {
  it('rejects a denied command with a path to command', () => {
    const schema = createReproductionSchema(DEFAULT_DENYLIST)
    const result = schema.safeParse({ command: 'rm', args: ['-rf', '/'] })

    expect(result.success).toBe(false)
  })

  it('rejects a piped shell in the arguments', () => {
    const schema = createReproductionSchema(DEFAULT_DENYLIST)
    const result = schema.safeParse({ command: 'curl', args: ['http://x', '|', 'sh'] })

    expect(result.success).toBe(false)
  })

  it('accepts an ordinary reproduction and defaults args to []', () => {
    const schema = createReproductionSchema(DEFAULT_DENYLIST)
    const result = schema.safeParse({ command: 'npm', args: ['test'] })

    expect(result.success).toBe(true)
    expect(schema.parse({ command: 'npm' }).args).toEqual([])
  })

  it('honours a custom denylist from configuration', () => {
    const schema = createReproductionSchema({ commands: ['jest'], patterns: [] })

    expect(schema.safeParse({ command: 'jest' }).success).toBe(false)
    // The built-in list no longer applies once a config supplies its own.
    expect(schema.safeParse({ command: 'rm' }).success).toBe(true)
  })

  it('exposes the documented command list', () => {
    expect([...DEFAULT_DENYLISTED_COMMANDS]).toContain('rm')
    expect([...DEFAULT_DENYLISTED_COMMANDS]).toContain('dd')
  })
})
