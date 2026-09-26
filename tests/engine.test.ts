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

describe('analyze: a reproduced failure', () => {
  /** Routes a failing reproduction plus git calls that route by subcommand. */
  function failingReproduction(workingTree: FakeOutcome) {
    return byCommand({
      npm: exit(1, { stderr: 'ETIMEDOUT\n' }),
      git: (call) => (call.args.includes('status') ? workingTree : INSIDE_WORK_TREE),
    })
  }

  it('allows the change on a clean tree', async () => {
    const { spawn } = fakeSpawner(failingReproduction(CLEAN_TREE))

    const result = await analyze(
      makeInput({ reproduction: { command: 'npm' } }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.decision).toBe('allow')
    expect(result.evidence.state).toBe('reproduced')
    expect(result.state.workingTree).toBe('clean')
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
      makeInput({ reproduction: { command: 'npm' }, runTests: true }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.decision).toBe('request_info')
    expect(result.evidence.state).toBe('reproduced')
    expect(result.state.workingTree).toBe('clean')
    expect(result.state.tests).toBe('pass')
    expect(result.reason).toMatch(/tests pass/i)
  })
})

describe('analyze: output contract', () => {
  it('always produces an output that satisfies the tool schema', async () => {
    const { spawn } = fullPipeline({})

    const result = await analyze(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(() => preActionCheckOutputSchema.parse(result)).not.toThrow()
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
