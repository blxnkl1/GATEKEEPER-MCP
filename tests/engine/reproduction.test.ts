/**
 * Reproduction stage tests.
 *
 * The command runner is faked throughout: no test here spawns a real process.
 * The only test that waits on real time is the timeout case, and even that uses
 * a child that never fires an event.
 */

import { describe, expect, it } from 'vitest'

import { MAX_OUTPUT_BYTES, executeCommand, runReproduction } from '../../src/engine/reproduction.js'
import {
  DEFAULT_DENYLIST,
  createReproductionSchema,
  preActionCheckInputSchema,
} from '../../src/schemas/pre_action_check.js'
import type { PreActionCheckInput } from '../../src/types/index.js'
import { exit, fakeSpawner, hang, makeDeps, spawnFailure } from './fakes.js'

/** Repository root used as the sandbox boundary in these tests. */
const ROOT = '/repo'

/** Builds validated tool input, always carrying the two required fields. */
function makeInput(overrides: Record<string, unknown> = {}): PreActionCheckInput {
  return preActionCheckInputSchema.parse({
    taskDescription: 'Fix the upload timeout',
    proposedChange: 'Add a retry around the upload call.',
    ...overrides,
  })
}

/** Dependency set rooted at a fake repository, with no spawner wired up. */
function inertDeps(): ReturnType<typeof makeDeps> {
  return makeDeps({ cwd: () => ROOT })
}

describe('runReproduction: nothing to verify', () => {
  it('is unverifiable when there is neither a command nor text evidence', async () => {
    const result = await runReproduction(makeInput(), inertDeps())

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toBe('No executable reproduction and no problem evidence supplied.')
  })

  it('is unverifiable when the text evidence is only whitespace', async () => {
    const result = await runReproduction(makeInput({ evidenceOfProblem: '   ' }), inertDeps())

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toMatch(/No executable reproduction and no problem evidence/)
  })

  it('is unverifiable, and asks for a command, when only text evidence is supplied', async () => {
    const result = await runReproduction(
      makeInput({ evidenceOfProblem: 'It crashes on start-up.' }),
      inertDeps(),
    )

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toMatch(/no executable reproduction/i)
  })
})

describe('runReproduction: exit code interpretation', () => {
  it('reports not_reproduced when a command expected to fail succeeds', async () => {
    const { spawn } = fakeSpawner(() => exit(0, { stdout: 'all good\n' }))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('not_reproduced')
    expect(result.exitCode).toBe(0)
    expect(result.detail).toMatch(/no failure observed/i)
    expect(result.durationMs).toBeTypeOf('number')
  })

  it('reports reproduced when a command expected to fail exits non-zero', async () => {
    const { spawn } = fakeSpawner(() => exit(1, { stderr: 'ETIMEDOUT\n' }))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm', args: ['test'] } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('reproduced')
    expect(result.exitCode).toBe(1)
    expect(result.detail).toContain('ETIMEDOUT')
  })

  it('reports reproduced when a command exits non-zero even if it was expected to succeed', async () => {
    const { spawn } = fakeSpawner(() => exit(2))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'node', expectFailure: false } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    // The declared expectation does not get a vote. A non-zero exit is a
    // failure that was actually observed, whatever the agent predicted.
    expect(result.state).toBe('reproduced')
    expect(result.exitCode).toBe(2)
  })
})

/**
 * The invariant this block exists to protect:
 *
 *   a successful execution is never failure evidence.
 *
 * `expectFailure` is descriptive metadata. It records what the agent expected
 * and it is echoed back in the detail string, but it must never be able to
 * convert a zero exit into `reproduced`, because `reproduced` is the only state
 * the decision engine can turn into `allow`.
 */
describe('runReproduction: a successful command is never failure evidence', () => {
  // The three payloads from the security report, each of which returned `allow`
  // before the invariant was restored. Only the exit code matters, so each is
  // scripted to succeed exactly as the real command would.
  const SUCCESSFUL_COMMANDS: Array<{ label: string; reproduction: Record<string, unknown> }> = [
    { label: 'true', reproduction: { command: 'true', expectFailure: false } },
    {
      label: 'echo',
      reproduction: { command: 'echo', args: ['test'], expectFailure: false },
    },
    {
      label: 'git --version',
      reproduction: { command: 'git', args: ['--version'], expectFailure: false },
    },
  ]

  for (const { label, reproduction } of SUCCESSFUL_COMMANDS) {
    it(`does not report reproduced for a successful "${label}" with expectFailure:false`, async () => {
      const { spawn } = fakeSpawner(() => exit(0, { stdout: 'output\n' }))

      const result = await runReproduction(
        makeInput({ reproduction }),
        makeDeps({ cwd: () => ROOT, spawn }),
      )

      expect(result.state).toBe('not_reproduced')
      expect(result.state).not.toBe('reproduced')
    })
  }

  it('reports not_reproduced for a zero exit under the default expectation too', async () => {
    const { spawn } = fakeSpawner(() => exit(0))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'node' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('not_reproduced')
  })

  it('ignores expectFailure:false for every zero exit code it could be given', async () => {
    // Exhaustive over the only two values a boolean can take, so the property
    // does not rest on a single hand-picked payload.
    for (const expectFailure of [true, false]) {
      const { spawn } = fakeSpawner(() => exit(0))

      const result = await runReproduction(
        makeInput({ reproduction: { command: 'node', expectFailure } }),
        makeDeps({ cwd: () => ROOT, spawn }),
      )

      expect(result.state, `expectFailure=${expectFailure}`).toBe('not_reproduced')
    }
  })

  it('never reports reproduced for any non-failing outcome', async () => {
    // Timeout and spawn failure are not failures of the code under test either,
    // so they must not be laundered into failure evidence by any expectation.
    for (const expectFailure of [true, false]) {
      const timedOut = await runReproduction(
        makeInput({
          reproduction: { command: 'node', timeoutMs: 1000, expectFailure },
        }),
        makeDeps({ cwd: () => ROOT, spawn: fakeSpawner(() => hang()).spawn }),
      )
      expect(timedOut.state, `timeout expectFailure=${expectFailure}`).toBe('timeout')

      const missing = await runReproduction(
        makeInput({ reproduction: { command: 'node', expectFailure } }),
        makeDeps({ cwd: () => ROOT, spawn: fakeSpawner(() => spawnFailure('ENOENT')).spawn }),
      )
      expect(missing.state, `ENOENT expectFailure=${expectFailure}`).toBe('unverifiable')
    }
  })

  it('explains in the detail that a successful command is not failure evidence', async () => {
    const { spawn } = fakeSpawner(() => exit(0))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'true', expectFailure: false } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.detail).toMatch(/no failure observed/i)
    expect(result.detail).not.toMatch(/reproduction succeeded/i)
  })
})

describe('runReproduction: command validation', () => {
  it('refuses a metacharacter command that the denylist does not already catch', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    // The schema's denylist refuses the obvious destructive forms before the
    // engine is reached, so this exercises the engine's own metacharacter guard
    // with a payload the denylist has no rule for. The guard is defence in depth
    // behind the denylist, not a replacement for it.
    //
    // Note: the engine's character class does not include the pipe. That is inert
    // here because the runner never uses a shell, but it is an incomplete guard
    // and is reported rather than quietly worked around.
    const result = await runReproduction(
      makeInput({ reproduction: { command: 'pytest;tee' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toMatch(/metacharacters/i)
    expect(calls).toHaveLength(0)
  })

  it('leaves denylist enforcement to the tool layer, so rejections stay auditable', () => {
    // Layering. The advertised MCP schema deliberately omits the denylist,
    // because the SDK validates arguments before the tool handler runs and a
    // rejection there would never produce a `denylist_rejected` audit event.
    // The engine is the second line of defence, not the first.
    expect(() =>
      makeInput({ reproduction: { command: 'npm;rm -rf /' } } as Record<string, unknown>),
    ).not.toThrow()

    // The refusal still happens, one layer up, against the active denylist.
    const parsed = createReproductionSchema(DEFAULT_DENYLIST).safeParse({
      command: 'npm;rm -rf /',
      args: [],
    })

    expect(parsed.success).toBe(false)
  })

  it('spawns nothing for a refused command, whichever layer catches it', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm;rm -rf /' } } as Record<string, unknown>),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(calls).toHaveLength(0)
  })

  it('refuses a shell string and explains how to split it', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm test' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toContain('args')
    expect(calls).toHaveLength(0)
  })

  it('refuses an argument containing a null byte', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'node', args: ['a\0b'] } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(calls).toHaveLength(0)
  })

  it('accepts an absolute executable path, which contains a slash', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: '/usr/bin/git' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('reproduced')
    expect(calls[0]?.command).toBe('/usr/bin/git')
  })
})

describe('runReproduction: working directory confinement', () => {
  it('refuses a cwd that escapes the repository root', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm', cwd: '../elsewhere' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toMatch(/outside the repository root/)
    expect(calls).toHaveLength(0)
  })

  it('refuses an absolute cwd outside the repository root', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm', cwd: '/etc' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(calls).toHaveLength(0)
  })

  it('accepts a nested cwd inside the repository and resolves it', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm', cwd: 'packages/api' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('reproduced')
    expect(calls[0]?.cwd).toBe('/repo/packages/api')
  })

  it('defaults the cwd to the repository root', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(1))

    await runReproduction(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(calls[0]?.cwd).toBe('/repo')
  })
})

describe('runReproduction: failure modes', () => {
  it('is unverifiable when the executable does not exist', async () => {
    const { spawn } = fakeSpawner(() => spawnFailure('ENOENT'))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'nope' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('unverifiable')
    expect(result.detail).toContain('ENOENT')
  })

  it('is unverifiable when the process dies on a signal rather than exiting', async () => {
    const { spawn } = fakeSpawner(() => ({ signal: 'SIGKILL' }))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    // A null exit code must never be read as either a pass or a failure.
    expect(result.state).toBe('unverifiable')
    expect(result.detail).toMatch(/abnormally/i)
    expect(result.exitCode).toBeUndefined()
  })

  it('times out and kills the child with SIGKILL', async () => {
    const { spawn, kills } = fakeSpawner(() => hang())

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'sleep', args: ['infinity'], timeoutMs: 1000 } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('timeout')
    expect(result.detail).toMatch(/exceeded its timeout/)
    expect(result.durationMs).toBeTypeOf('number')
    expect(kills).toEqual(['SIGKILL'])
  }, 15000)
})

describe('executeCommand: process hardening', () => {
  it('never uses a shell and never inherits stdin', async () => {
    const { spawn, calls } = fakeSpawner(() => exit(0))

    await executeCommand(
      { command: 'npm', args: ['test'], cwd: '/repo', timeoutMs: 5000 },
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(calls[0]?.shell).toBe(false)
    expect(calls[0]?.stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })

  it('caps captured stdout at 16 KB and discards the rest', async () => {
    const { spawn } = fakeSpawner(() => exit(0, { stdout: 'x'.repeat(1024 * 1024) }))

    const result = await executeCommand(
      { command: 'noisy', args: [], cwd: '/repo', timeoutMs: 5000 },
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(MAX_OUTPUT_BYTES).toBe(16 * 1024)
    expect(result.stdout).toHaveLength(MAX_OUTPUT_BYTES)
  })

  it('caps captured stderr independently of stdout', async () => {
    const { spawn } = fakeSpawner(() => exit(1, { stderr: 'e'.repeat(512 * 1024) }))

    const result = await executeCommand(
      { command: 'noisy', args: [], cwd: '/repo', timeoutMs: 5000 },
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.stderr).toHaveLength(MAX_OUTPUT_BYTES)
  })

  it('reports a spawn failure instead of throwing', async () => {
    const { spawn } = fakeSpawner(() => spawnFailure('ENOENT'))

    const result = await executeCommand(
      { command: 'missing', args: [], cwd: '/repo', timeoutMs: 5000 },
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.spawnError).toBe('ENOENT')
    expect(result.exitCode).toBeNull()
  })

  it('never leaves the pending timeout timer holding the event loop open', async () => {
    const { spawn } = fakeSpawner(() => exit(0))

    const result = await executeCommand(
      { command: 'fast', args: [], cwd: '/repo', timeoutMs: 300_000 },
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    // If the timer were still pending, vitest would hang here for 5 minutes
    // rather than finishing immediately.
    expect(result.timedOut).toBe(false)
  })

  it('strips ANSI escapes and control characters from the detail text', async () => {
    const { spawn } = fakeSpawner(() => exit(1, { stdout: '\u001B[31mred alert\u001B[0m done\n' }))

    const result = await runReproduction(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.state).toBe('reproduced')
    expect(result.detail).toContain('red alert')
    // No ANSI escape and no raw control character survives into the detail.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting on control characters is the point
    expect(result.detail).not.toMatch(/[\u0000-\u001F\u007F]/)
  })
})
