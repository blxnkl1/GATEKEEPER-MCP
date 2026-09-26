/**
 * Stage 2: state inspector.
 *
 * Answers a different question from stage 1: "is it safe to interpret this
 * reproduction, and is the work perhaps already done?" Two facts matter.
 *
 * First, a dirty working tree makes a reproduction untrustworthy: the failure
 * being observed may come from someone's uncommitted work-in-progress rather
 * than from committed code, so approving a change on that evidence risks
 * building on a transient state. Second, a test suite that already passes while
 * the reproduction fails usually means the reproduction and the suite are
 * testing different things, which means the reproduction is probably wrong.
 *
 * Every process is launched through {@link executeCommand} so that the shell
 * avoidance, timeout handling, and output capping of the reproduction stage
 * apply here too.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { z } from 'zod'

import { logger } from '../logger.js'
import type { Deps, PreActionCheckInput, StateInfo } from '../types/index.js'
import { excerpt, executeCommand, resolveRepoRoot } from './reproduction.js'

/**
 * Default ceiling for the verification command.
 *
 * A full suite is expected to be slow, so this is far more generous than the
 * reproduction timeout. It is overridable with `testTimeoutMs` because a
 * project's suite is now load-bearing: an operator whose suite needs longer can
 * raise the ceiling rather than lose the ability to reach `allow`.
 */
export const TEST_TIMEOUT_MS = 120_000

/** Minimal shape read from the project's `package.json`. */
const packageManifestSchema = z.object({
  scripts: z.record(z.string()).optional(),
})

/** Package managers recognised in Phase 2, ordered by lockfile precedence. */
const PACKAGE_MANAGERS = [
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm' },
  { lockfile: 'yarn.lock', command: 'yarn' },
  { lockfile: 'bun.lockb', command: 'bun' },
  { lockfile: 'bun.lock', command: 'bun' },
] as const

/**
 * Picks the package manager implied by the lockfile present in `root`.
 *
 * The lockfile is the only reliable signal: a repository can have `npm` in its
 * `packageManager` field and a `pnpm-lock.yaml` on disk, and the lockfile is
 * what actually governs an install. With no lockfile at all the project was
 * most likely set up with npm, which is the default assumption.
 *
 * @param root Absolute repository root.
 * @returns The package manager command to invoke.
 */
function detectPackageManager(root: string): string {
  for (const manager of PACKAGE_MANAGERS) {
    if (existsSync(resolve(root, manager.lockfile))) {
      return manager.command
    }
  }
  return 'npm'
}

/**
 * Reads the project's `package.json` and reports whether it has a test script.
 *
 * The manifest is an untrusted file that may be malformed, so it is validated
 * with zod rather than cast. A missing or unreadable manifest is not an error:
 * it simply means no test runner could be recognised.
 *
 * @param root Absolute repository root.
 * @returns The parsed manifest, or `null` when it is absent or invalid.
 */
function readManifest(root: string): z.infer<typeof packageManifestSchema> | null {
  const manifestPath = resolve(root, 'package.json')
  if (!existsSync(manifestPath)) {
    return null
  }
  try {
    return packageManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch (error) {
    logger.debug({ err: error, manifestPath }, 'state: could not parse package.json')
    return null
  }
}

/**
 * Resolves the verification command to run.
 *
 * An operator-configured `testCommand` always wins. It is an argv array, so
 * configuring it never introduces a shell, and it is server-side state: the
 * agent cannot influence which command decides whether the project is broken.
 * Only when it is unset does the package-manager heuristic apply, and that
 * heuristic is also server-side.
 *
 * @param root Absolute repository root.
 * @param configured Operator-declared argv, if any.
 * @returns The argv to run, or null when no verification command is known.
 */
export function resolveTestCommand(
  root: string,
  configured: readonly string[] | undefined,
): { command: string; args: string[] } | null {
  if (configured !== undefined && configured.length > 0) {
    const [command, ...args] = configured
    if (command !== undefined) {
      return { command, args }
    }
  }

  const manifest = readManifest(root)
  if (manifest === null) {
    return null
  }
  if (manifest.scripts?.test === undefined) {
    return null
  }

  const command = detectPackageManager(root)
  return { command, args: ['test'] }
}

/**
 * Runs the project's test suite and reports the outcome.
 *
 * Only the exit code is interpreted. Test output is deliberately not parsed:
 * every runner formats its output differently, and a gatekeeper that scraped
 * for the word "failed" would be wrong more often than a gatekeeper that trusts
 * the exit code. A small excerpt is logged to stderr for a human debugging a
 * surprise, but it never influences the verdict.
 *
 * @param root Absolute repository root.
 * @param deps Injected dependencies.
 * @param configured Operator-declared argv, if any.
 * @param timeoutMs Ceiling for the suite.
 * @returns The suite verdict plus a detail string.
 */
async function runTestSuite(
  root: string,
  deps: Deps,
  configured: readonly string[] | undefined,
  timeoutMs: number,
): Promise<{ tests: StateInfo['tests']; detail: string }> {
  const resolved = resolveTestCommand(root, configured)
  if (resolved === null) {
    return {
      tests: 'unknown',
      detail:
        'No verification command is known: package.json defines no "test" script. ' +
        'Set `testCommand` in .gatekeeperrc.json so the gate can confirm the project is actually failing.',
    }
  }

  const { command, args } = resolved
  const result = await executeCommand({ command, args, cwd: root, timeoutMs }, deps)

  logger.debug(
    {
      command,
      args,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stderr: excerpt(result.stderr),
    },
    'state: verification command finished',
  )

  if (result.spawnError !== null) {
    return {
      tests: 'unknown',
      detail: `Could not start "${command}" (${result.spawnError}).`,
    }
  }

  if (result.timedOut) {
    return {
      tests: 'unknown',
      detail: `The verification command exceeded ${timeoutMs}ms and was killed; its result is unknown.`,
    }
  }

  if (result.exitCode === null) {
    return {
      tests: 'unknown',
      detail: 'The verification command terminated abnormally; its result is unknown.',
    }
  }

  const printable = [command, ...args].join(' ')
  return result.exitCode === 0
    ? { tests: 'pass', detail: `"${printable}" exited 0 after ${result.durationMs}ms.` }
    : {
        tests: 'fail',
        detail: `"${printable}" exited ${result.exitCode} after ${result.durationMs}ms.`,
      }
}

/**
 * Inspects the git working tree and, when it can change the verdict, the
 * project's verification command.
 *
 * The working tree is described first because a clean tree is a precondition
 * for treating a reproduction as trustworthy. When the tree is not a git
 * repository at all, the result is `unknown` rather than an error: the
 * gatekeeper must still be able to gate a change in an unpacked tarball.
 *
 * The verification command is not optional. It used to be gated on an
 * agent-supplied `runTests` flag, which meant the agent could decline to have
 * its claim cross-checked and still be approved — see rule 5b' in
 * `decision.ts`. It now runs whenever it can affect the outcome, which means
 * whenever a reproduction was observed on a clean tree.
 *
 * @param input Validated tool input.
 * @param deps Injected dependencies.
 * @param options Whether the verification command is worth running, and how.
 * @returns The working tree and verification verdicts, with an explanatory detail.
 */
export async function inspectState(
  input: PreActionCheckInput,
  deps: Deps,
  options: { runVerification: boolean; testCommand?: readonly string[]; testTimeoutMs?: number } = {
    runVerification: false,
  },
): Promise<StateInfo> {
  const root = await resolveRepoRoot(deps)

  // Confirm this is a git work tree before trusting any git output. `git status`
  // fails outside a repository, but relying on that failure alone would report a
  // missing binary and a missing repository identically.
  const inside = await executeCommand(
    { command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd: root, timeoutMs: 10_000 },
    deps,
  )

  if (inside.spawnError !== null) {
    return {
      workingTree: 'unknown',
      tests: 'skipped',
      detail: `Not a git repository: git is unavailable (${inside.spawnError}).`,
    }
  }

  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return {
      workingTree: 'unknown',
      tests: 'skipped',
      detail: 'Not a git repository.',
    }
  }

  const status = await executeCommand(
    { command: 'git', args: ['status', '--porcelain'], cwd: root, timeoutMs: 10_000 },
    deps,
  )

  let workingTree: StateInfo['workingTree']
  let treeDetail: string

  if (status.spawnError !== null) {
    workingTree = 'unknown'
    treeDetail = `Could not run git status (${status.spawnError}).`
  } else if (status.exitCode !== 0) {
    workingTree = 'unknown'
    treeDetail = `git status exited ${status.exitCode ?? 'null'}.`
  } else if (status.stdout.trim() === '') {
    workingTree = 'clean'
    treeDetail = 'The git working tree is clean.'
  } else {
    workingTree = 'dirty'
    const changed = status.stdout.split('\n').filter((line) => line.trim() !== '')
    const preview = changed
      .slice(0, 5)
      .map((line) => line.trim())
      .join('; ')
    const extra = changed.length > 5 ? ` (+${changed.length - 5} more)` : ''
    treeDetail = `The git working tree has ${changed.length} uncommitted change(s): ${preview}${extra}`
  }

  if (!options.runVerification) {
    logger.debug({ workingTree }, 'state: verification command not required for this verdict')
    return { workingTree, tests: 'skipped', detail: treeDetail }
  }

  const suite = await runTestSuite(
    root,
    deps,
    options.testCommand,
    options.testTimeoutMs ?? TEST_TIMEOUT_MS,
  )
  return {
    workingTree,
    tests: suite.tests,
    detail: suite.detail === '' ? treeDetail : `${treeDetail} ${suite.detail}`,
  }
}
