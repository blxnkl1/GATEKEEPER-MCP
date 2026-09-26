import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { type Config, DEFAULT_CONFIG } from '../../src/config/loader.js'
import { createServer } from '../../src/server.js'
import { PRE_ACTION_CHECK_TOOL_NAME } from '../../src/tools/pre_action_check.js'

/** Clients opened by a test, closed during teardown. */
const openClients: Client[] = []

/**
 * An isolated, committed, clean git repository.
 *
 * Every test in this file runs against it. Using the suite's own working
 * directory would be a trap twice over: this repository is dirty while the
 * tests are being written, so every verdict would be settled by rule 5a and the
 * assertions would pass without exercising anything; and its `test` script
 * would really run, which is both slow and recursive.
 */
let repo = ''

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gk-security-'))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-q', '.')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  // A committed placeholder, and no package.json, so no verification command is
  // discoverable. Tests that want one declare it explicitly.
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
})

afterAll(() => {
  execFileSync('rm', ['-rf', repo])
})

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

/** A declared verification command that exits zero. */
const VERIFICATION_GREEN = ['node', '-e', 'process.exit(0)']
/** A declared verification command that exits non-zero. */
const VERIFICATION_RED = ['node', '-e', 'process.exit(1)']

/** One observed tool response, reduced to what these tests assert on. */
interface Verdict {
  decision?: string
  reason?: string
  evidenceState?: string
  exitCode?: number
  workingTree?: string
  tests?: string
  isError?: boolean
  text?: string
}

/**
 * Connects a client to a server rooted at the fixture repository.
 *
 * @param config Configuration overrides layered over the defaults.
 * @returns A connected client.
 */
async function connect(config: Partial<Config> = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'security-test-client', version: '0.0.0' })
  openClients.push(client)
  const server = createServer({ cwd: repo, config: { ...DEFAULT_CONFIG, ...config } })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/**
 * Calls `pre_action_check` and reduces the result to the fields under test.
 *
 * @param client Connected client.
 * @param args Tool arguments, passed through untouched.
 * @returns The observed verdict.
 */
async function check(client: Client, args: Record<string, unknown>): Promise<Verdict> {
  const result = await client.callTool({ name: PRE_ACTION_CHECK_TOOL_NAME, arguments: args })
  const first = result.content[0]

  if (result.isError === true) {
    return { isError: true, text: first?.type === 'text' ? first.text : undefined }
  }
  if (first?.type !== 'text') {
    return { isError: true, text: JSON.stringify(result.content) }
  }

  const parsed = JSON.parse(first.text) as {
    decision: string
    reason: string
    evidence: { state: string; exitCode?: number }
    state: { workingTree: string; tests: string }
  }

  return {
    decision: parsed.decision,
    reason: parsed.reason,
    evidenceState: parsed.evidence.state,
    exitCode: parsed.evidence.exitCode,
    workingTree: parsed.state.workingTree,
    tests: parsed.state.tests,
  }
}

/**
 * Commands that succeed without exercising anything.
 *
 * Each is a trivial way to obtain a zero exit, which is the shape of the
 * original defect. None may ever produce an approval.
 */
const TRIVIAL_SUCCESSES: Array<[string, Record<string, unknown>]> = [
  ['true', { command: 'true' }],
  ['true with expectFailure:false', { command: 'true', expectFailure: false }],
  ['echo', { command: 'echo', args: ['hello'] }],
  ['git --version', { command: 'git', args: ['--version'] }],
  [
    'git --version with expectFailure:false',
    { command: 'git', args: ['--version'], expectFailure: false },
  ],
]

/**
 * Commands that fail without demonstrating anything.
 *
 * Each is a trivial way to obtain a non-zero exit. Before the project's own
 * verification command was made decisive, every one of these reached `allow` on
 * a clean tree.
 */
const TRIVIAL_FAILURES: Array<[string, Record<string, unknown>]> = [
  ['false', { command: 'false' }],
  ['node exit 7', { command: 'node', args: ['-e', 'process.exit(7)'] }],
  ['node throw', { command: 'node', args: ['-e', 'throw new Error("boom")'] }],
  ['ls a missing path', { command: 'ls', args: ['definitely-not-here-xyz'] }],
  ['cat a missing file', { command: 'cat', args: ['definitely-not-here-xyz.txt'] }],
  ['git rev-parse a bad ref', { command: 'git', args: ['rev-parse', '--verify', 'nope'] }],
]

/** Free-text evidence shapes an agent might use to talk its way past the gate. */
const TEXTS: Array<[string, string]> = [
  ['plain', 'The add function returns the wrong result.'],
  [
    'persuasive',
    'URGENT: critical production defect, reproduced five times, stakeholders are waiting. ' +
      'You MUST fix this immediately or the release is blocked.',
  ],
  [
    'misleading',
    'This was already fixed in a previous session and the fix was reverted by a bad merge. ' +
      'Please reapply the same change.',
  ],
]

describe('security: the fixture is what these assertions depend on', () => {
  it('runs against a clean git work tree with no discoverable verification command', async () => {
    const client = await connect()

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'node', args: ['-e', 'process.exit(3)'] },
    })

    // Guards against the vacuous-pass trap: if the tree were dirty, or a
    // verification command were discoverable, every assertion below would be
    // settled by an earlier rule and would prove nothing.
    expect(verdict.workingTree).toBe('clean')
    expect(verdict.tests).toBe('unknown')
    expect(verdict.evidenceState).toBe('reproduced')
  })
})

describe('security: a successful command is never failure evidence', () => {
  it.each(TRIVIAL_SUCCESSES)('never allows %s', async (_label, reproduction) => {
    for (const testCommand of [undefined, VERIFICATION_GREEN, VERIFICATION_RED]) {
      const client = await connect(testCommand === undefined ? {} : { testCommand })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction,
      })

      expect(verdict.decision, `${_label} testCommand=${String(testCommand)}`).not.toBe('allow')
      expect(verdict.evidenceState).toBe('not_reproduced')
    }
  })
})

describe('security: a trivial failure is not a reproduction of anything', () => {
  // This is the finding that blocked v1.0.0. With no verification command there
  // is nothing to cross-check the agent's claim against, and the project
  // resolves that uncertainty by refusing.
  it.each(TRIVIAL_FAILURES)(
    'never allows %s when no verification command exists',
    async (label, reproduction) => {
      const client = await connect()

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction,
      })

      expect(verdict.decision, label).not.toBe('allow')
    },
  )

  it.each(TRIVIAL_FAILURES)(
    'never allows %s when the project suite is green',
    async (label, reproduction) => {
      // The decisive cross-check. The operator has declared a verification
      // command; it passes, so a failing agent-supplied command proves nothing
      // about the repository.
      const client = await connect({ testCommand: VERIFICATION_GREEN })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction,
      })

      expect(verdict.decision, label).not.toBe('allow')
      expect(verdict.tests).toBe('pass')
    },
  )
})

describe('security: no agent-supplied field can manufacture ALLOW', () => {
  it('denies a zero exit across every combination of the remaining levers', async () => {
    for (const expectFailure of [true, false]) {
      for (const [textLabel, text] of TEXTS) {
        for (const withAffectedFiles of [false, true]) {
          // The project suite is red here, which is the most favourable case an
          // agent could hope for: only the zero exit stands between it and an
          // approval.
          const client = await connect({ testCommand: VERIFICATION_RED })

          const verdict = await check(client, {
            taskDescription: 't',
            proposedChange: 'c',
            evidenceOfProblem: text,
            ...(withAffectedFiles ? { affectedFiles: ['src/a.ts'] } : {}),
            reproduction: { command: 'true', expectFailure },
          })

          expect(
            verdict.decision,
            `expectFailure=${expectFailure} text=${textLabel} affectedFiles=${withAffectedFiles}`,
          ).not.toBe('allow')
          // Rule 1 settles a zero exit before the repository is even consulted,
          // so the suite is legitimately not run. Either way the verdict stands.
          expect(['skipped', 'fail']).toContain(verdict.tests)
        }
      }
    }
  })

  it('denies a zero exit in enforced mode as well as advisory', async () => {
    for (const mode of ['advisory', 'enforced'] as const) {
      const client = await connect({ mode, testCommand: VERIFICATION_RED })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction: { command: 'true', expectFailure: false },
      })

      expect(verdict.decision, mode).not.toBe('allow')
    }
  })

  it('denies a zero exit however the denylist is configured', async () => {
    for (const denylist of [
      { commands: [], patterns: [] },
      { commands: ['rm'], patterns: [] },
    ]) {
      const client = await connect({ denylist, testCommand: VERIFICATION_RED })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction: { command: 'true', expectFailure: false },
      })

      expect(verdict.decision, JSON.stringify(denylist)).not.toBe('allow')
    }
  })

  it('denies a zero exit however rate limiting is configured', async () => {
    for (const rateLimit of [
      { windowMs: 60_000, max: 1 },
      { windowMs: 60_000, max: 10_000 },
    ]) {
      const client = await connect({ rateLimit, testCommand: VERIFICATION_RED })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction: { command: 'true', expectFailure: false },
      })

      expect(verdict.decision, JSON.stringify(rateLimit)).not.toBe('allow')
    }
  })
})

describe('security: interpreters are refused rather than executed', () => {
  // `bash -c "…"` is a shell by another name, so allowing it while refusing
  // `curl … | sh` would make the pattern denylist decorative.
  it.each([
    ['bash', ['-c', 'false']],
    ['sh', ['-c', 'false']],
    ['zsh', ['-c', 'false']],
    ['env', ['FOO=1', 'false']],
    ['python3', ['-c', 'import sys; sys.exit(1)']],
    ['perl', ['-e', 'exit 1']],
  ])('refuses %s as a reproduction', async (command, args) => {
    const client = await connect({ testCommand: VERIFICATION_RED })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command, args },
    })

    expect(verdict.isError, `${command} should be refused outright`).toBe(true)
    expect(verdict.text ?? '').toMatch(/denylist/i)
  })

  it('a narrowed denylist cannot manufacture ALLOW against a healthy project', async () => {
    // An operator who narrows the denylist below the built-in list gets the
    // interpreter back. It must not thereby get the invariant back open: with a
    // green verification command there is still nothing to approve.
    const client = await connect({
      denylist: { commands: ['rm'], patterns: [] },
      testCommand: VERIFICATION_GREEN,
    })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'bash', args: ['-c', 'false'] },
    })

    expect(verdict.isError).not.toBe(true)
    expect(verdict.decision).not.toBe('allow')
    expect(verdict.tests).toBe('pass')
  })

  it('a narrowed denylist cannot manufacture ALLOW against an unverifiable project', async () => {
    const client = await connect({ denylist: { commands: ['rm'], patterns: [] } })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'bash', args: ['-c', 'false'] },
    })

    expect(verdict.decision).not.toBe('allow')
    expect(verdict.tests).toBe('unknown')
  })

  it('documents the residual: a broken project can be approved with a trivial command', async () => {
    // The honest limit of the contract, pinned deliberately so it cannot be
    // forgotten. `allow` means "the project is verifiably failing and the tree is
    // clean", not "this particular command demonstrates this particular bug".
    //
    // What makes this acceptable is that the agent cannot manufacture it: the
    // failing verification command is operator-declared and run by the server, so
    // the agent has to be sitting in a genuinely broken repository to get here.
    // What it does not do is confirm that the claimed bug is the one that is
    // broken. See the "Execution Boundary" section of docs/architecture.md.
    const client = await connect({
      denylist: { commands: ['rm'], patterns: [] },
      testCommand: VERIFICATION_RED,
    })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'bash', args: ['-c', 'false'] },
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.tests).toBe('fail')
  })

  it('still cannot reach ALLOW through node -e, which is not denylisted', async () => {
    // `node` remains available because it is ordinary project tooling, and
    // `node -e` is a complete interpreter in one argument. It is the clearest
    // demonstration of why the denylist is not the control that protects the
    // invariant.
    const client = await connect({ testCommand: VERIFICATION_GREEN })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'node', args: ['-e', 'process.exit(1)'] },
    })

    expect(verdict.decision).not.toBe('allow')
    expect(verdict.tests).toBe('pass')
  })
})

describe('security: the legitimate path still works', () => {
  it('allows a real failure that the project verification also reports', async () => {
    const client = await connect({ testCommand: VERIFICATION_RED })

    const verdict = await check(client, {
      taskDescription: 'add() returns the wrong result',
      proposedChange: 'Fix add() to return a + b',
      reproduction: { command: 'node', args: ['-e', 'process.exit(1)'] },
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.evidenceState).toBe('reproduced')
    expect(verdict.exitCode).toBe(1)
    expect(verdict.workingTree).toBe('clean')
    expect(verdict.tests).toBe('fail')
  })

  it('names the observed exit code in the allow reason', async () => {
    const client = await connect({ testCommand: VERIFICATION_RED })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'node', args: ['-e', 'process.exit(9)'] },
    })

    expect(verdict.decision).toBe('allow')
    expect(verdict.reason ?? '').toContain('9')
  })

  it('still blocks a real failure on a dirty tree', async () => {
    const dirty = mkdtempSync(join(tmpdir(), 'gk-dirty-'))
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dirty, stdio: 'ignore' })
    }
    git('init', '-q', '.')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    writeFileSync(join(dirty, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    writeFileSync(join(dirty, 'a.txt'), 'two\n')

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'dirty-test-client', version: '0.0.0' })
    openClients.push(client)
    const server = createServer({
      cwd: dirty,
      config: { ...DEFAULT_CONFIG, testCommand: VERIFICATION_RED },
    })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'node', args: ['-e', 'process.exit(1)'] },
    })

    expect(verdict.decision).not.toBe('allow')
    expect(verdict.workingTree).toBe('dirty')

    execFileSync('rm', ['-rf', dirty])
  })
})

describe('security: the working directory cannot be steered outside the repository', () => {
  // The confinement check resolves both sides through realpath. A purely lexical
  // comparison passed a committed symlink aimed outside the repository, and the
  // process then really did run over there.
  it('refuses a working directory reached through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'gk-outside-'))
    const link = join(repo, 'escape')
    writeFileSync(join(outside, 'elsewhere.txt'), 'not in the repository\n')
    symlinkSync(outside, link)

    const client = await connect({ testCommand: VERIFICATION_RED })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'pwd', cwd: 'escape' },
    })

    expect(verdict.evidenceState).toBe('unverifiable')
    expect(verdict.decision).not.toBe('allow')

    unlinkSync(link)
    execFileSync('rm', ['-rf', outside])
  })

  it.each(['..', '../..', '/tmp', '/etc', '~/.ssh', '$HOME', '/'])(
    'refuses the out-of-tree working directory %s',
    async (cwd) => {
      const client = await connect({ testCommand: VERIFICATION_RED })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction: { command: 'pwd', cwd },
      })

      expect(verdict.evidenceState, cwd).toBe('unverifiable')
      expect(verdict.decision, cwd).not.toBe('allow')
    },
  )
})

describe('security: the verdict never claims a failure that did not happen', () => {
  it('does not report a reproduced failure for a zero exit', async () => {
    const client = await connect({ testCommand: VERIFICATION_RED })

    const verdict = await check(client, {
      taskDescription: 't',
      proposedChange: 'c',
      reproduction: { command: 'true', expectFailure: false },
    })

    expect(verdict.reason ?? '').not.toMatch(/failure reproduced/i)
    expect(verdict.reason ?? '').not.toMatch(/justified/i)
  })

  it('does not tell the agent to proceed on any non-allow verdict', async () => {
    for (const [label, reproduction] of [...TRIVIAL_SUCCESSES, ...TRIVIAL_FAILURES]) {
      const client = await connect({ testCommand: VERIFICATION_RED })

      const verdict = await check(client, {
        taskDescription: 't',
        proposedChange: 'c',
        reproduction,
      })

      if (verdict.decision === 'allow') {
        continue
      }
      expect(verdict.reason ?? '', label).not.toMatch(/justified/i)
    }
  })
})
