/**
 * End-to-end pipeline tests.
 *
 * These drive the real `analyze()` with faked dependencies, so they cover the
 * stage ordering, the short-circuit, and the wiring between the stages. No test
 * here spawns a process or runs real git.
 */

import { describe, expect, it } from 'vitest'

import { analyze } from '../src/engine/analyzer.js'
import {
  preActionCheckInputSchema,
  preActionCheckOutputSchema,
  preActionCheckResponseSchema,
} from '../src/schemas/pre_action_check.js'
import type { PreActionCheckInput } from '../src/types/index.js'
import type { FakeOutcome } from './engine/fakes.js'
import {
  CLEAN_TREE,
  INSIDE_WORK_TREE,
  byCommand,
  dirtyTree,
  exit,
  fakeSpawner,
  makeDeps,
} from './engine/fakes.js'

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

/** Routes the reproduction command and both git commands in one spawner. */
function fullPipeline(routes: Parameters<typeof byCommand>[0]): ReturnType<typeof fakeSpawner> {
  return fakeSpawner(byCommand(routes))
}

describe('analyze: no evidence', () => {
  it('denies a change with neither a command nor text evidence', async () => {
    const { spawn, calls } = fullPipeline({})

    const result = await analyze(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.decision).toBe('deny')
    expect(result.reason).toMatch(/No evidence of a problem was supplied/i)
    expect(result.evidence.state).toBe('unverifiable')
    expect(result.state.workingTree).toBe('unknown')
  })

  it('short-circuits before inspecting the repository', async () => {
    const { spawn, calls } = fullPipeline({})

    await analyze(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    // Nothing was spawned at all: a change that is going to be denied never
    // needs the repository inspected.
    expect(calls).toHaveLength(0)
  })

  it('asks for an executable reproduction when only text evidence is supplied', async () => {
    const { spawn } = fullPipeline({ git: INSIDE_WORK_TREE })

    const result = await analyze(
      makeInput({ evidenceOfProblem: 'It crashes on start-up.' }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).toBe('request_info')
    expect(result.evidence.state).toBe('unverifiable')
  })
})

describe('analyze: a reproduction that does not fail', () => {
  it('denies the change when the command succeeds', async () => {
    const { spawn, calls } = fullPipeline({
      npm: exit(0, { stdout: 'all tests pass\n' }),
    })

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).toBe('deny')
    expect(result.evidence.state).toBe('not_reproduced')
    expect(result.evidence.exitCode).toBe(0)
    // Short-circuited: git was never consulted.
    expect(calls).toHaveLength(1)
  })
})

/**
 * The security invariant, asserted through the whole pipeline rather than one
 * stage: reproduction, then state inspection, then the decision.
 *
 * Every case here reached `allow` before the invariant was restored. The agent
 * supplied both the command and `expectFailure: false`, so it could pick a
 * command guaranteed to exit zero and have that success read back as a
 * reproduced failure.
 */
describe('analyze: a successful command can never be approved', () => {
  /** Git routed so the state inspector always sees a clean work tree. */
  const cleanRepo = {
    git: (call: { args: string[] }) =>
      call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE,
  }

  const SUCCESSFUL_COMMANDS: Array<{ label: string; reproduction: Record<string, unknown> }> = [
    { label: 'true', reproduction: { command: 'true', expectFailure: false } },
    { label: 'echo', reproduction: { command: 'echo', args: ['test'], expectFailure: false } },
    {
      label: 'git --version',
      reproduction: { command: 'git', args: ['--version'], expectFailure: false },
    },
  ]

  for (const { label, reproduction } of SUCCESSFUL_COMMANDS) {
    it(`denies "${label}" with expectFailure:false on a clean tree`, async () => {
      // `git` does double duty: the reproduction asks for `--version`, and the
      // state inspector asks for `rev-parse` and `status`.
      const { spawn } = fakeSpawner(
        byCommand({
          true: exit(0),
          echo: exit(0, { stdout: 'test\n' }),
          git: (call) => {
            if (call.args.includes('--version')) {
              return exit(0, { stdout: 'git version 2.39.0\n' })
            }
            return call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE
          },
        }),
      )

      const result = await analyze(
        makeInput({ reproduction }),
        makeDeps({ cwd: () => ROOT, spawn }),
      )

      expect(result.decision, label).not.toBe('allow')
      expect(result.evidence.state, label).toBe('not_reproduced')
      expect(result.reason, label).not.toMatch(/failure reproduced/i)
    })
  }

  it('denies a zero exit declared with the default expectation too', async () => {
    const { spawn } = fakeSpawner(byCommand({ true: exit(0), ...cleanRepo }))

    const result = await analyze(
      makeInput({ reproduction: { command: 'true' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).not.toBe('allow')
  })

  it('denies a zero exit even when the agent also supplies persuasive prose', async () => {
    const { spawn } = fakeSpawner(byCommand({ true: exit(0), ...cleanRepo }))

    const result = await analyze(
      makeInput({
        evidenceOfProblem:
          'This was reproduced three times on staging with a full stack trace ending in ETIMEDOUT.',
        reproduction: { command: 'true', expectFailure: false },
      }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).not.toBe('allow')
  })

  it('never approves a successful command across every input variation', async () => {
    for (const expectFailure of [true, false]) {
      for (const runTests of [false, true]) {
        for (const withText of [false, true]) {
          const { spawn } = fakeSpawner(byCommand({ true: exit(0), ...cleanRepo }))

          const result = await analyze(
            makeInput({
              reproduction: { command: 'true', expectFailure },
              ...(withText ? { evidenceOfProblem: 'It crashes on start-up.' } : {}),
              runTests,
            }),
            makeDeps({ cwd: () => ROOT, spawn }),
          )

          expect(
            result.decision,
            `expectFailure=${expectFailure}/runTests=${runTests}/text=${withText}`,
          ).not.toBe('allow')
        }
      }
    }
  })

  it('still approves a genuine failure the project verification also reports', async () => {
    // The other half of the property: tightening the contract must not have
    // closed the legitimate path to `allow`. Both the reproduction and the
    // project's own verification command have to fail.
    const { spawn } = fakeSpawner(
      byCommand({ npm: exit(1, { stderr: 'ETIMEDOUT\n' }), ...cleanRepo }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
      { testCommand: ['npm', 'test'] },
    )

    expect(result.decision).toBe('allow')
    expect(result.evidence.state).toBe('reproduced')
    expect(result.evidence.exitCode).toBe(1)
    expect(result.state.tests).toBe('fail')
  })

  it('denies a genuine failure the project verification contradicts', async () => {
    // The decisive cross-check: the agent's command fails but the project's own
    // tests do not, so the claim is confirmed by nothing the agent controls.
    const { spawn } = fakeSpawner(
      byCommand({
        npm: (call) => (call.args.includes('test') ? exit(0) : exit(1, { stderr: 'boom\n' })),
        ...cleanRepo,
      }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
      { testCommand: ['npm', 'test'] },
    )

    expect(result.decision).not.toBe('allow')
    expect(result.state.tests).toBe('pass')
  })

  it('denies a genuine failure when the project has no verification command', async () => {
    // No observable verification surface is uncertainty, and this project
    // resolves uncertainty by refusing.
    const { spawn } = fakeSpawner(byCommand({ npm: exit(1, { stderr: 'boom\n' }), ...cleanRepo }))

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).toBe('deny')
    expect(result.state.tests).toBe('unknown')
  })

  it('approves a non-zero exit even when the agent declared it should pass', async () => {
    // The declared expectation gets no vote in either direction: a non-zero
    // exit is a failure that really happened.
    const { spawn } = fakeSpawner(
      byCommand({
        node: exit(1, { stderr: 'assertion failed\n' }),
        // The project's own verification command also fails.
        npm: exit(1),
        ...cleanRepo,
      }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'node', expectFailure: false } }),
      makeDeps({ cwd: () => ROOT, spawn }),
      { testCommand: ['npm', 'test'] },
    )

    expect(result.decision).toBe('allow')
    expect(result.evidence.exitCode).toBe(1)
  })

  it('does not approve a reproduction that timed out', async () => {
    const { spawn } = fakeSpawner(byCommand({ node: { neverExit: true }, ...cleanRepo }))

    const result = await analyze(
      makeInput({ reproduction: { command: 'node', timeoutMs: 1000, expectFailure: false } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).not.toBe('allow')
    expect(result.evidence.state).toBe('timeout')
  })

  it('does not approve a reproduction that could not start', async () => {
    const { spawn } = fakeSpawner(
      byCommand({ 'no-such-binary': { errorCode: 'ENOENT' }, ...cleanRepo }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'no-such-binary', expectFailure: false } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).not.toBe('allow')
    expect(result.evidence.state).toBe('unverifiable')
  })
})

describe('analyze: a reproduced failure', () => {
  /** Routes a failing reproduction plus git calls that route by subcommand. */
  function failingReproduction(workingTree: FakeOutcome) {
    return byCommand({
      npm: exit(1, { stderr: 'ETIMEDOUT\n' }),
      git: (call) => (call.args.includes('status') ? workingTree : INSIDE_WORK_TREE),
    })
  }

  it('allows the change on a clean tree with a failing project suite', async () => {
    const { spawn } = fakeSpawner(failingReproduction(CLEAN_TREE))

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
      { testCommand: ['npm', 'test'] },
    )

    expect(result.decision).toBe('allow')
    expect(result.evidence.state).toBe('reproduced')
    expect(result.state.workingTree).toBe('clean')
    expect(result.state.tests).toBe('fail')
  })

  it('holds the change back when the project suite is green', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        // The reproduction fails; the project's own `npm test` passes.
        npm: (call) => (call.args.includes('test') ? exit(0) : exit(1, { stderr: 'boom\n' })),
        git: (call) => (call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE),
      }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
      { testCommand: ['npm', 'test'] },
    )

    expect(result.decision).toBe('request_info')
    expect(result.state.tests).toBe('pass')
  })

  it('holds the change back on a dirty tree', async () => {
    const { spawn } = fakeSpawner(failingReproduction(dirtyTree(' M src/upload.ts')))

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).toBe('request_info')
    expect(result.reason).toMatch(/dirty/i)
    expect(result.state.workingTree).toBe('dirty')
  })

  it('runs the reproduction before touching git', async () => {
    const { spawn, calls } = fakeSpawner(failingReproduction(CLEAN_TREE))

    await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(calls[0]?.command).toBe('npm')
    expect(calls[1]?.args).toContain('rev-parse')
    expect(calls[2]?.args).toContain('status')
  })

  it('allows the change when a requested suite also fails', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        // The bare `npm` invocation is the reproduction and fails; `npm test`
        // is the suite and fails too, which is consistent.
        npm: exit(1, { stderr: 'ETIMEDOUT\n' }),
        git: (call) => (call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE),
      }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' }, runTests: true }),
      // The real project root, so a test script is actually found on disk.
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.decision).toBe('allow')
    expect(result.evidence.state).toBe('reproduced')
    expect(result.state.tests).toBe('fail')
  })

  it('holds the change back when a green suite contradicts the failure', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        // The bare `npm` invocation is the reproduction and fails, while
        // `npm test` passes, so the two contradict each other.
        npm: (call) => (call.args.includes('test') ? exit(0) : exit(1, { stderr: 'ETIMEDOUT\n' })),
        git: (call) => (call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE),
      }),
    )

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
      { testCommand: ['npm', 'test'] },
    )

    expect(result.decision).toBe('request_info')
    expect(result.evidence.state).toBe('reproduced')
    expect(result.state.workingTree).toBe('clean')
    expect(result.state.tests).toBe('pass')
    expect(result.reason).toMatch(/verification command passes/i)
  })
})

describe('analyze: output contract', () => {
  it('always produces an output that satisfies the tool schema', async () => {
    const { spawn } = fullPipeline({})

    const result = await analyze(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(() => preActionCheckOutputSchema.parse(result)).not.toThrow()
  })

  it('keeps the nonce out of the engine result, which is stamped by the tool', async () => {
    const { spawn } = fullPipeline({})
    const result = await analyze(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    // A nonce describes one reply to one caller, not a policy outcome, so the
    // frozen engine must not know about it. The tool layer adds it.
    expect(Object.keys(result)).not.toContain('nonce')
    expect(() =>
      preActionCheckResponseSchema.parse({ ...result, nonce: 'a'.repeat(22) }),
    ).not.toThrow()
  })

  it('includes the evidence and the state on a deny', async () => {
    const { spawn } = fullPipeline({ npm: exit(0) })

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.evidence.state).toBe('not_reproduced')
    expect(result.state.workingTree).toBe('unknown')
    expect(result.state.tests).toBe('skipped')
    expect(result.state.detail).toBe('skipped')
  })
})
