/**
 * Stage 1: reproduction checker.
 *
 * Answers a single question: "has the agent demonstrated that a problem actually
 * exists?" This is the cheapest and most effective defence against Action Bias,
 * because the overwhelming majority of unnecessary edits are attempts to fix
 * something that was never broken. Without evidence there is nothing to justify
 * an edit against.
 *
 * This module also owns {@link executeCommand}, the single hardened primitive
 * used to run every external process in the engine. Stage 2 reuses it so that
 * timeout handling, output capping, and shell avoidance are implemented once
 * rather than per call site.
 *
 * See the "Reproduction Safety Model" section of `docs/architecture.md` for the
 * full rationale behind each guard below.
 */

import { resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { logger } from '../logger.js'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../schemas/pre_action_check.js'
import type { Deps, Evidence, PreActionCheckInput } from '../types/index.js'

/**
 * Maximum number of bytes retained from each of stdout and stderr.
 *
 * Output is capped because a reproduction that prints a megabyte, or worse, an
 * unbounded stream, would otherwise be buffered in full and then pasted into a
 * log line or an error message. The cap also guarantees the engine never
 * accumulates an unbounded amount of child output in memory.
 *
 * Capped output is discarded, never forwarded to stdout. stdout belongs to the
 * JSON-RPC frame stream and a single stray byte there corrupts the protocol.
 */
export const MAX_OUTPUT_BYTES = 16 * 1024

/** Longest child-output excerpt embedded in a human-readable detail string. */
const MAX_DETAIL_EXCERPT = 200

/**
 * Characters that must never appear in a `command`.
 *
 * The engine always spawns with `shell: false`, so a metacharacter here is not
 * an injection risk in itself; it is a signal that the agent has misunderstood
 * the parameter and is trying to hand us a shell string such as
 * `npm test && echo done`. Rejecting it is clearer than letting the spawn fail
 * with an opaque error, and it keeps a future refactor that enables a shell from
 * silently becoming exploitable. Note that `/` is deliberately absent, since a
 * bare executable is very often an absolute path.
 */
const SHELL_METACHARACTERS = /[\s;&$`<>()[\]{}*?!~#\\'"]/

/** ANSI escape sequences, stripped before any output is shown to a user. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]/g

/** Remaining C0 control characters, stripped after the ANSI pass. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/g

/** How the engine was asked to run a command, with all defaults applied. */
export interface CommandSpec {
  /** Bare executable to run. Never passed through a shell. */
  command: string
  /** Arguments for the executable. */
  args: string[]
  /** Absolute working directory, already verified to be inside the repo root. */
  cwd: string
  /** Milliseconds to wait before killing the command. */
  timeoutMs: number
}

/** What {@link executeCommand} observed. */
export interface CommandResult {
  /** Exit code, or `null` when the process was signalled or never started. */
  exitCode: number | null
  /** Captured stdout, truncated to {@link MAX_OUTPUT_BYTES}. */
  stdout: string
  /** Captured stderr, truncated to {@link MAX_OUTPUT_BYTES}. */
  stderr: string
  /** Wall-clock duration in milliseconds, measured with `deps.now()`. */
  durationMs: number
  /** Whether the command was killed because it exceeded its timeout. */
  timedOut: boolean
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null
  /** Spawn failure such as `ENOENT`, or `null` if the process started. */
  spawnError: string | null
}

/** Clamps a caller-supplied timeout into the range the engine will honour. */
export function clampTimeout(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/**
 * Appends a chunk to `current`, keeping at most {@link MAX_OUTPUT_BYTES}.
 *
 * @param current Accumulated output so far.
 * @param chunk Incoming chunk from the child stream.
 * @returns The new accumulated output, never longer than the cap.
 */
function appendCapped(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_OUTPUT_BYTES) {
    return current
  }
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  return current + text.slice(0, MAX_OUTPUT_BYTES - current.length)
}

/**
 * Renders child output as a short, safe excerpt.
 *
 * ANSI sequences and control characters are stripped so that the excerpt cannot
 * rewrite the terminal of whoever reads the detail string, and the result is
 * truncated so a verbose command cannot dominate the log.
 *
 * @param output Raw captured output.
 * @returns A single-line excerpt, or an empty string when there is no output.
 */
export function excerpt(output: string): string {
  const cleaned = output.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, ' ').trim()
  if (cleaned === '') {
    return ''
  }
  const collapsed = cleaned.replace(/\s+/g, ' ')
  return collapsed.length > MAX_DETAIL_EXCERPT
    ? `${collapsed.slice(0, MAX_DETAIL_EXCERPT)}...`
    : collapsed
}

/**
 * Runs a command under the engine's safety rules.
 *
 * The command is spawned directly, with `shell: false`, so the executable and
 * its arguments are passed to the operating system verbatim and no shell ever
 * parses them. This is the single most important guard in the module: a shell
 * would interpret metacharacters in agent-supplied input, turning a description
 * of a bug into arbitrary code execution.
 *
 * stdin is closed rather than inherited so a command that reads from it sees EOF
 * instead of consuming the JSON-RPC request stream. Both output streams are
 * piped and capped. The child is killed with `SIGKILL` on timeout, which cannot
 * be caught or ignored by the child.
 *
 * @param spec The command to run, with defaults already applied.
 * @param deps Injected dependencies.
 * @returns What was observed, including exit code, capped output, and duration.
 */
export async function executeCommand(spec: CommandSpec, deps: Deps): Promise<CommandResult> {
  const startedAt = deps.now()
  const child = deps.spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    // No shell: the executable and arguments reach the OS untouched.
    shell: false,
    // stdin is ignored so the child can never read the JSON-RPC request stream.
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let finished = false
  let spawnError: string | null = null

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (finished) {
      return
    }
    stdout = appendCapped(stdout, chunk)
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (finished) {
      return
    }
    stderr = appendCapped(stderr, chunk)
  })

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    child.once('close', (code, signal) => {
      settle({ code, signal })
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error.code ?? error.message
      settle({ code: null, signal: null })
    })
  })

  // The timer is created with an AbortSignal so it can be cancelled the moment
  // the command finishes. Without that, a pending timer would keep the event
  // loop alive for up to timeoutMs after every call.
  const controller = new AbortController()
  const expiry = delay(spec.timeoutMs, undefined, { signal: controller.signal })
    .then(() => 'timeout' as const)
    // Aborting rejects the delay promise; swallow it so it never surfaces as an
    // unhandled rejection after the race has already been decided.
    .catch(() => 'cancelled' as const)

  /**
   * Result of racing the process against the timeout.
   *
   * The `cancelled` variant is defensive only: the controller is aborted after
   * the race has already settled, so the timer losing that race cannot be
   * observed here. It is handled rather than ignored so that the narrowing below
   * is total and no code path can fall through to an undefined exit code.
   */
  type Outcome =
    | { kind: 'closed'; code: number | null; signal: NodeJS.Signals | null }
    | { kind: 'timeout' }
    | { kind: 'cancelled' }

  const outcome: Outcome = await Promise.race<Outcome>([
    closed.then((result) => ({ kind: 'closed', ...result })),
    expiry.then((kind) => ({ kind })),
  ])

  controller.abort()
  finished = true

  const durationMs = Math.max(0, deps.now() - startedAt)

  if (outcome.kind === 'timeout') {
    // SIGKILL cannot be caught or ignored, so the child cannot outlive this call
    // by choice. We report immediately rather than awaiting `close`, because a
    // gatekeeper that blocks the agent session on an unresponsive child is
    // worse than one that returns a timeout verdict.
    child.kill('SIGKILL')
    logger.debug(
      { command: spec.command, timeoutMs: spec.timeoutMs, durationMs },
      'reproduction: command timed out and was killed',
    )
    return {
      exitCode: null,
      stdout,
      stderr,
      durationMs,
      timedOut: true,
      signal: null,
      spawnError: null,
    }
  }

  if (outcome.kind === 'cancelled') {
    // Unreachable in practice. Reported as an abnormal termination so the
    // caller treats it as unverifiable rather than as a passing reproduction.
    return {
      exitCode: null,
      stdout,
      stderr,
      durationMs,
      timedOut: false,
      signal: null,
      spawnError: null,
    }
  }

  return {
    exitCode: outcome.code,
    stdout,
    stderr,
    durationMs,
    timedOut: false,
    signal: outcome.signal,
    spawnError,
  }
}

/**
 * Rejects a path that escapes the repository root.
 *
 * Confining the working directory stops a reproduction from being pointed at
 * `/etc`, `$HOME`, or another checkout. This check is lexical, so a symlink
 * inside the repository that points outside it is not caught; that limitation
 * is recorded in `docs/phases.md`.
 *
 * @param root Absolute, resolved repository root.
 * @param target Absolute, resolved candidate path.
 * @returns Whether `target` is the root itself or lives beneath it.
 */
function isInsideRepo(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * Runs the agent's reproduction command and reports what happened.
 *
 * Free-text evidence is deliberately not treated as proof. A paragraph
 * describing a stack trace is exactly as easy to fabricate as a change is to
 * justify, so it can only ever lead to `request_info`. Only an executed command
 * whose exit code matches the agent's stated expectation produces `reproduced`,
 * and `reproduced` is the only state that can lead to `allow`.
 *
 * @param input Validated tool input.
 * @param deps Injected dependencies.
 * @returns The reproduction verdict, with detail safe to show to the user.
 */
export async function runReproduction(input: PreActionCheckInput, deps: Deps): Promise<Evidence> {
  const spec = input.reproduction
  const hasTextEvidence =
    input.evidenceOfProblem !== undefined && input.evidenceOfProblem.trim() !== ''

  // Nothing executable and nothing written down: there is no claim to check.
  if (spec === undefined) {
    const detail = hasTextEvidence
      ? 'Free-text evidence supplied but no executable reproduction. Provide a command that fails on the bug.'
      : 'No executable reproduction and no problem evidence supplied.'
    logger.debug('reproduction: nothing to verify, reporting unverifiable')
    return { state: 'unverifiable', detail }
  }

  if (spec.command.trim() === '') {
    return { state: 'unverifiable', detail: 'The reproduction command is empty.' }
  }

  if (SHELL_METACHARACTERS.test(spec.command)) {
    return {
      state: 'unverifiable',
      detail:
        'The reproduction command contains shell metacharacters or spaces. ' +
        'Set `command` to a bare executable and pass everything else through `args`, ' +
        'for example command "npm" with args ["test"].',
    }
  }

  if (spec.args.some((arg) => arg.includes('\0'))) {
    return { state: 'unverifiable', detail: 'A reproduction argument contains a null byte.' }
  }

  const root = resolve(deps.cwd())
  const cwd = spec.cwd === undefined ? root : resolve(root, spec.cwd)

  if (!isInsideRepo(root, cwd)) {
    return {
      state: 'unverifiable',
      detail: `The reproduction cwd "${spec.cwd}" resolves outside the repository root (${root}).`,
    }
  }

  const expectFailure = spec.expectFailure ?? true
  const result = await executeCommand(
    {
      command: spec.command,
      args: spec.args ?? [],
      cwd,
      timeoutMs: clampTimeout(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    },
    deps,
  )

  // Log a short, sanitized summary to stderr. Never log raw child output to
  // stdout: that stream carries the JSON-RPC frames.
  logger.debug(
    {
      command: spec.command,
      args: spec.args,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
      durationMs: result.durationMs,
      stdout: excerpt(result.stdout),
      stderr: excerpt(result.stderr),
    },
    'reproduction: command finished',
  )

  if (result.spawnError !== null) {
    return {
      state: 'unverifiable',
      detail: `The reproduction command could not be started (${result.spawnError}). Verify that "${spec.command}" exists and is on PATH.`,
    }
  }

  if (result.timedOut) {
    return {
      state: 'timeout',
      detail: `Reproduction command exceeded its timeout and was killed after ${result.durationMs}ms.`,
      durationMs: result.durationMs,
    }
  }

  if (result.exitCode === null) {
    const reason = result.signal === null ? 'no exit code' : `signal ${result.signal}`
    return {
      state: 'unverifiable',
      detail: `The reproduction command terminated abnormally (${reason}); this is not evidence of a failure.`,
      durationMs: result.durationMs,
    }
  }

  const failed = result.exitCode !== 0
  const reproduced = expectFailure ? failed : !failed
  const outcomeLine = excerpt(result.stdout) || excerpt(result.stderr)

  const base = {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  }

  if (reproduced) {
    const detail = expectFailure
      ? `Reproduction succeeded: "${spec.command}" exited ${result.exitCode} in ${result.durationMs}ms.`
      : `Reproduction succeeded: "${spec.command}" exited ${result.exitCode} in ${result.durationMs}ms, which is the expected outcome.`
    return {
      state: 'reproduced',
      detail: outcomeLine === '' ? detail : `${detail} Output: ${outcomeLine}`,
      ...base,
    }
  }

  const detail = expectFailure
    ? 'Command succeeded; no failure observed.'
    : 'Command failed, but it was declared to be expected to succeed.'
  return {
    state: 'not_reproduced',
    detail: outcomeLine === '' ? detail : `${detail} Output: ${outcomeLine}`,
    ...base,
  }
}
