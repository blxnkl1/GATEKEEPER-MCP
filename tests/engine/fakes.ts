/**
 * Fake dependencies for engine tests.
 *
 * Every side effect the engine performs goes through {@link Deps}, so these
 * fakes are the only reason the test suite can exercise the real pipeline
 * without spawning a process, running real git, or waiting on a real clock.
 * No test in this project may call `child_process` or real `git` directly.
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import type { Deps } from '../../src/types/index.js'

/** Arguments the engine passed to `spawn`, as observed by a fake. */
export interface FakeCall {
  command: string
  args: string[]
  cwd?: string
  shell?: boolean | string
  stdio?: unknown
}

/** Scripted behaviour for one spawned process. */
export interface FakeOutcome {
  /** Text emitted on stdout. */
  stdout?: string
  /** Text emitted on stderr. */
  stderr?: string
  /** Exit code reported on close. Defaults to 0. */
  exitCode?: number
  /** When set, report death by this signal instead of by an exit code. */
  signal?: NodeJS.Signals
  /** When set, emit an `error` event with this `code`, e.g. `ENOENT`. */
  errorCode?: string
  /** When true, never emit `close`, simulating a hanging command. */
  neverExit?: boolean
}

/** Decides what a spawned process should do. */
export type FakeHandler = (call: FakeCall) => FakeOutcome

/** A scripted process that exited with `code`. */
export function exit(code: number, extra: Omit<FakeOutcome, 'exitCode'> = {}): FakeOutcome {
  return { exitCode: code, ...extra }
}

/** A scripted process that never finishes, for exercising the timeout path. */
export function hang(stdout = ''): FakeOutcome {
  return { neverExit: true, stdout }
}

/** A scripted process that failed to start. */
export function spawnFailure(code: string): FakeOutcome {
  return { errorCode: code }
}

/** The fake spawn function together with everything it recorded. */
export interface FakeSpawner {
  spawn: Deps['spawn']
  /** Every call the engine made, in order. */
  calls: FakeCall[]
  /** Every signal the engine sent to a child, in order. */
  kills: Array<NodeJS.Signals | number | undefined>
}

/** The mutable shape of a fake child process. */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: (signal?: NodeJS.Signals | number) => boolean
}

/**
 * Builds a `spawn` replacement that scripts child processes.
 *
 * The returned child is an {@link EventEmitter} exposing only the surface the
 * engine actually uses: `stdout` and `stderr` streams, a `close` event, an
 * `error` event, and `kill`. Output is delivered on the next tick, and `close`
 * on the tick after that, so the engine sees the same event ordering a real
 * process produces.
 *
 * @param handler Decides what each spawned process does.
 * @returns The fake `spawn`, plus the calls and kills it recorded.
 */
export function fakeSpawner(handler: FakeHandler): FakeSpawner {
  const calls: FakeCall[] = []
  const kills: FakeSpawner['kills'] = []

  const spawn = ((command: string, args: string[], options?: FakeCall): ChildProcess => {
    const call: FakeCall = {
      command,
      args,
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.shell === undefined ? {} : { shell: options.shell }),
      ...(options?.stdio === undefined ? {} : { stdio: options.stdio }),
    }
    calls.push(call)

    const outcome = handler(call)
    // The engine only ever touches the surface declared here, so a partial
    // stand-in is enough and keeps the fake free of unrelated plumbing.
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 4242,
      kill: (signal?: NodeJS.Signals | number): boolean => {
        kills.push(signal)
        // A killed process really does close a moment later.
        setImmediate(() => {
          child.emit('close', null, signal ?? 'SIGKILL')
        })
        return true
      },
    })

    setImmediate(() => {
      if (outcome.errorCode !== undefined) {
        const error: NodeJS.ErrnoException = Object.assign(
          new Error(`spawn ${outcome.errorCode} ${command}`),
          { code: outcome.errorCode },
        )
        child.emit('error', error)
        return
      }

      child.stdout.emit('data', Buffer.from(outcome.stdout ?? ''))
      child.stderr.emit('data', Buffer.from(outcome.stderr ?? ''))

      if (outcome.neverExit === true) {
        return
      }
      setImmediate(() => {
        // A process killed by a signal reports a null exit code, which the
        // engine must treat as abnormal rather than as a pass or a failure.
        if (outcome.signal !== undefined) {
          child.emit('close', null, outcome.signal)
          return
        }
        child.emit('close', outcome.exitCode ?? 0, null)
      })
    })

    return child as unknown as ChildProcess
  }) as Deps['spawn']

  return { spawn, calls, kills }
}

/**
 * Builds a dependency set for a test.
 *
 * The defaults are deliberately hostile: `spawn` throws and `exec` throws, so a
 * test that forgets to inject a fake fails loudly instead of silently touching
 * the real system. `exec` is a tripwire by design, because `exec` always runs
 * through a shell and the engine must never have a shell code path.
 *
 * @param overrides Fields to replace. Anything omitted keeps the safe default.
 * @returns A complete dependency set.
 */
export function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const notInjected = (name: string) => () => {
    throw new Error(`Test called the real ${name}. Inject a fake via makeDeps({ ${name}: ... }).`)
  }

  return {
    spawn: notInjected('spawn') as unknown as Deps['spawn'],
    exec: notInjected('exec') as unknown as Deps['exec'],
    cwd: () => process.cwd(),
    now: () => Date.now(),
    ...overrides,
  }
}

/**
 * A handler that routes by the command's first argument.
 *
 * Matches `command` exactly, so `git` and `npm` can be scripted independently.
 * An unmatched command exits 0, which keeps a test that only cares about one
 * call from having to script the others.
 *
 * @param routes Map of command to its scripted outcome.
 * @returns A handler suitable for {@link fakeSpawner}.
 */
export function byCommand(routes: Record<string, FakeOutcome | FakeHandler>): FakeHandler {
  return (call) => {
    const route = routes[call.command]
    if (route === undefined) {
      return exit(0)
    }
    return typeof route === 'function' ? route(call) : route
  }
}

/** A `git rev-parse --is-inside-work-tree` route that reports a real work tree. */
export const INSIDE_WORK_TREE: FakeOutcome = { exitCode: 0, stdout: 'true\n' }

/** A `git rev-parse` route that reports the directory is not a repository. */
export const NOT_A_REPO: FakeOutcome = { exitCode: 128, stderr: 'not a git repository\n' }

/** A `git status --porcelain` route for a clean tree. */
export const CLEAN_TREE: FakeOutcome = { exitCode: 0, stdout: '' }

/**
 * A `git status --porcelain` route for a dirty tree.
 *
 * @param lines Porcelain status lines, without trailing newlines.
 * @returns A scripted outcome.
 */
export function dirtyTree(...lines: string[]): FakeOutcome {
  return { exitCode: 0, stdout: `${lines.join('\n')}\n` }
}
