/**
 * State inspector tests.
 *
 * Git and the test suite are both faked: no test here runs real git or a real
 * test suite. The only real filesystem access is reading this project's own
 * `package.json` to detect a test script, which is why the test-runner cases
 * assert that precondition explicitly.
 */

import { describe, expect, it } from 'vitest'

import { inspectState } from '../../src/engine/state.js'
import { preActionCheckInputSchema } from '../../src/schemas/pre_action_check.js'
import type { PreActionCheckInput } from '../../src/types/index.js'
import {
  CLEAN_TREE,
  INSIDE_WORK_TREE,
  NOT_A_REPO,
  byCommand,
  dirtyTree,
  exit,
  fakeSpawner,
  makeDeps,
  spawnFailure,
} from './fakes.js'

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

/**
 * Routes the two git commands to fixed outcomes.
 *
 * `git rev-parse --is-inside-work-tree` and `git status --porcelain` are
 * distinguished by their arguments, since both are invoked as `git`.
 *
 * @param status Outcome for `git status --porcelain`.
 * @param revParse Outcome for `git rev-parse`.
 * @returns A handler suitable for `fakeSpawner`.
 */
function gitRoutes(
  status: { exitCode?: number; stdout?: string; stderr?: string } = {},
  revParse: { exitCode?: number; stdout?: string; stderr?: string } = INSIDE_WORK_TREE,
) {
  return byCommand({
    git: (call) => {
      if (call.args.includes('status')) {
        return { exitCode: 0, ...status }
      }
      if (call.args.includes('rev-parse')) {
        return { exitCode: 0, ...revParse }
      }
      return exit(0)
    },
  })
}

describe('inspectState: repository detection', () => {
  it('reports unknown when the directory is not a git repository', async () => {
    const { spawn } = fakeSpawner(gitRoutes({}, NOT_A_REPO))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('unknown')
    expect(result.tests).toBe('skipped')
    expect(result.detail).toBe('Not a git repository.')
  })

  it('reports unknown when git itself is not installed', async () => {
    const { spawn } = fakeSpawner(() => spawnFailure('ENOENT'))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('unknown')
    expect(result.detail).toMatch(/git is unavailable/i)
  })

  it('does not run git status at all when the directory is not a repository', async () => {
    const { spawn, calls } = fakeSpawner(gitRoutes({}, { exitCode: 128 }))

    await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toContain('rev-parse')
  })
})

describe('inspectState: working tree', () => {
  it('reports clean when git status returns no output', async () => {
    const { spawn } = fakeSpawner(gitRoutes(CLEAN_TREE))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('clean')
    expect(result.detail).toBe('The git working tree is clean.')
  })

  it('reports clean when git status returns only whitespace', async () => {
    const { spawn } = fakeSpawner(gitRoutes({ stdout: '\n  \n' }))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('clean')
  })

  it('reports dirty and counts the changed files', async () => {
    const { spawn } = fakeSpawner(gitRoutes(dirtyTree(' M src/upload.ts', '?? src/new.ts')))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('dirty')
    expect(result.detail).toContain('2 uncommitted change(s)')
    expect(result.detail).toContain('src/upload.ts')
  })

  it('truncates a long change list in the detail string', async () => {
    const lines = Array.from({ length: 8 }, (_, i) => ` M src/file${i}.ts`)
    const { spawn } = fakeSpawner(gitRoutes(dirtyTree(...lines)))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('dirty')
    expect(result.detail).toContain('+3 more')
  })

  it('reports unknown when git status fails', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        git: (call) => (call.args.includes('status') ? exit(128) : INSIDE_WORK_TREE),
      }),
    )

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.workingTree).toBe('unknown')
    expect(result.detail).toMatch(/git status exited 128/)
  })
})

describe('inspectState: test suite', () => {
  it('skips the test suite when runTests is not requested', async () => {
    const { spawn, calls } = fakeSpawner(gitRoutes(CLEAN_TREE))

    const result = await inspectState(makeInput(), makeDeps({ cwd: () => ROOT, spawn }))

    expect(result.tests).toBe('skipped')
    // Only the two git commands ran; no package manager was invoked.
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.command === 'git')).toBe(true)
  })

  it('skips the test suite when runTests is explicitly false', async () => {
    const { spawn } = fakeSpawner(gitRoutes(CLEAN_TREE))

    const result = await inspectState(
      makeInput({ runTests: false }),
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.tests).toBe('skipped')
  })

  it('reports pass when the suite exits zero', async () => {
    // The runner is detected by reading this repository's real package.json,
    // which is the only genuine filesystem read in the engine test suite.
    const { spawn, calls } = fakeSpawner(
      byCommand({
        git: (call) => (call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE),
        npm: exit(0, { stdout: 'ok\n' }),
      }),
    )

    const result = await inspectState(
      makeInput({ runTests: true }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.tests).toBe('pass')
    expect(result.detail).toContain('exited 0')
    expect(calls.some((call) => call.command === 'npm' && call.args.includes('test'))).toBe(true)
  })

  it('reports fail when the suite exits non-zero', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        git: (call) => (call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE),
        npm: exit(1, { stdout: '1 test failed\n' }),
      }),
    )

    const result = await inspectState(
      makeInput({ runTests: true }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.tests).toBe('fail')
    expect(result.detail).toContain('exited 1')
  })

  it('reports unknown when the suite command cannot be started', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        git: (call) => (call.args.includes('status') ? CLEAN_TREE : INSIDE_WORK_TREE),
        npm: spawnFailure('ENOENT'),
      }),
    )

    const result = await inspectState(
      makeInput({ runTests: true }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.tests).toBe('unknown')
    expect(result.detail).toMatch(/Could not start/i)
  })

  it('reports unknown when there is no readable package.json', async () => {
    const { spawn, calls } = fakeSpawner(gitRoutes(CLEAN_TREE))

    const result = await inspectState(
      makeInput({ runTests: true }),
      // ROOT has no package.json on disk, so no runner can be recognised.
      makeDeps({ cwd: () => ROOT, spawn }),
    )

    expect(result.tests).toBe('unknown')
    expect(result.detail).toMatch(/no test runner was recognised/i)
    // No package manager was started.
    expect(calls.every((call) => call.command === 'git')).toBe(true)
  })

  it('skips the test run when the directory is not a git repository', async () => {
    const { spawn, calls } = fakeSpawner(gitRoutes({}, { exitCode: 128 }))

    const result = await inspectState(
      makeInput({ runTests: true }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.tests).toBe('skipped')
    expect(calls).toHaveLength(1)
  })

  it('keeps the working tree verdict alongside the test verdict', async () => {
    const { spawn } = fakeSpawner(
      byCommand({
        git: (call) =>
          call.args.includes('status') ? dirtyTree(' M src/upload.ts') : INSIDE_WORK_TREE,
        npm: exit(0),
      }),
    )

    const result = await inspectState(
      makeInput({ runTests: true }),
      makeDeps({ cwd: () => process.cwd(), spawn }),
    )

    expect(result.workingTree).toBe('dirty')
    expect(result.tests).toBe('pass')
    expect(result.detail).toContain('uncommitted change(s)')
    expect(result.detail).toContain('exited 0')
  })
})
