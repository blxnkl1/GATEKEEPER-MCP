/**
 * Decision engine tests.
 *
 * The policy is a flat ordered rule list, so it is tested as a table: one row
 * per branch, each naming the rule it pins. The table is followed by an
 * exhaustive reachability check on `allow`, which is the one verdict that can
 * let an agent edit a file and therefore the one that must be hardest to reach
 * by accident.
 */

import { describe, expect, it, vi } from 'vitest'

import { decide } from '../../src/engine/decision.js'
import { logger } from '../../src/logger.js'
import { preActionCheckInputSchema } from '../../src/schemas/pre_action_check.js'
import type {
  DecisionKind,
  Evidence,
  PreActionCheckInput,
  StateInfo,
} from '../../src/types/index.js'

/** Builds validated tool input, always carrying the two required fields. */
function makeInput(overrides: Record<string, unknown> = {}): PreActionCheckInput {
  return preActionCheckInputSchema.parse({
    taskDescription: 'Fix the upload timeout',
    proposedChange: 'Add a retry around the upload call.',
    ...overrides,
  })
}

/** Builds a reproduction-stage result. */
function evidence(state: Evidence['state'], overrides: Partial<Evidence> = {}): Evidence {
  return { state, detail: 'test detail', ...overrides }
}

/**
 * Builds a state-inspection result.
 *
 * The default `tests` is `fail` because that is the only verification result
 * from which `allow` is reachable: a clean tree plus a failing project
 * verification command. Callers override it to exercise the blocking rules.
 */
function state(overrides: Partial<StateInfo> = {}): StateInfo {
  return { workingTree: 'clean', tests: 'fail', detail: 'test detail', ...overrides }
}

/** One row of the policy table. */
interface Case {
  name: string
  rule: string
  input: PreActionCheckInput
  evidence: Evidence
  state: StateInfo
  expected: DecisionKind
}

const CASES: Case[] = [
  {
    name: 'a reproduction that passed disproves the change',
    rule: '1',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('not_reproduced', { exitCode: 0 }),
    state: state(),
    expected: 'deny',
  },
  {
    name: 'rule 1 wins even when text evidence is also supplied',
    rule: '1 precedence',
    input: makeInput({
      reproduction: { command: 'npm' },
      evidenceOfProblem: 'I saw it fail once.',
    }),
    evidence: evidence('not_reproduced', { exitCode: 0 }),
    state: state(),
    expected: 'deny',
  },
  {
    name: 'no evidence of any kind denies the change',
    rule: '2',
    input: makeInput(),
    evidence: evidence('unverifiable'),
    state: state(),
    expected: 'deny',
  },
  {
    name: 'unverifiable free-text evidence asks for a command',
    rule: '3',
    input: makeInput({ evidenceOfProblem: 'It crashes on start-up.' }),
    evidence: evidence('unverifiable'),
    state: state(),
    expected: 'request_info',
  },
  {
    name: 'a timeout asks the agent to narrow the reproduction',
    rule: '4',
    input: makeInput({ reproduction: { command: 'npm', timeoutMs: 1000 } }),
    evidence: evidence('timeout', { durationMs: 1000 }),
    state: state(),
    expected: 'request_info',
  },
  {
    name: 'a dirty tree blocks an otherwise valid reproduction',
    rule: '5a',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ workingTree: 'dirty' }),
    expected: 'request_info',
  },
  {
    name: 'an unverifiable tree blocks an otherwise valid reproduction',
    rule: '5a-prime',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ workingTree: 'unknown' }),
    expected: 'request_info',
  },
  {
    name: 'a reproduced failure on a clean tree allows the change',
    rule: '5c',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state(),
    expected: 'allow',
  },
  {
    name: 'a reproduced failure with a failing project suite allows the change',
    rule: '5c',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ tests: 'fail' }),
    expected: 'allow',
  },
  {
    name: 'a green verification surface contradicting the reproduction blocks it',
    rule: '5b',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ tests: 'pass' }),
    expected: 'request_info',
  },
  {
    name: 'a green verification surface blocks even with no suite result requested',
    rule: '5b',
    input: makeInput({ reproduction: { command: 'npm' }, runTests: true } as Record<
      string,
      unknown
    >),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ tests: 'pass' }),
    expected: 'request_info',
  },
  {
    name: 'an unobservable verification surface blocks a reproduced failure',
    rule: '5b-prime',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ tests: 'unknown' }),
    expected: 'deny',
  },
  {
    name: 'a skipped verification surface blocks a reproduced failure',
    rule: '5b-prime',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ tests: 'skipped' }),
    expected: 'deny',
  },
  {
    name: 'a passing suite is no longer ignorable by omitting runTests',
    rule: '5b',
    input: makeInput({ reproduction: { command: 'npm' } }),
    evidence: evidence('reproduced', { exitCode: 1 }),
    state: state({ tests: 'pass' }),
    expected: 'request_info',
  },
  {
    name: 'a zero exit is never failure evidence, whatever the agent declared',
    rule: "5a''",
    input: makeInput({ reproduction: { command: 'node', expectFailure: false } }),
    evidence: evidence('reproduced', { exitCode: 0 }),
    state: state(),
    expected: 'deny',
  },
]

describe('decide: policy table', () => {
  for (const testCase of CASES) {
    it(`rule ${testCase.rule}: ${testCase.name}`, () => {
      const result = decide(testCase.input, testCase.evidence, testCase.state)

      expect(result.decision).toBe(testCase.expected)
    })
  }
})

describe('decide: output contract', () => {
  it('always returns the evidence and state that produced the verdict', () => {
    const result = decide(
      makeInput({ reproduction: { command: 'npm' } }),
      evidence('reproduced', { exitCode: 1 }),
      state(),
    )

    expect(result.evidence.state).toBe('reproduced')
    expect(result.evidence.exitCode).toBe(1)
    expect(result.state.workingTree).toBe('clean')
  })

  it('always returns a non-empty reason and at least one next step', () => {
    for (const testCase of CASES) {
      const result = decide(testCase.input, testCase.evidence, testCase.state)

      expect(result.reason.length).toBeGreaterThan(0)
      expect(result.nextSteps.length).toBeGreaterThan(0)
      for (const step of result.nextSteps) {
        expect(step.length).toBeGreaterThan(0)
      }
    }
  })

  it('never instructs the agent to make the change on a non-allow verdict', () => {
    for (const testCase of CASES) {
      const result = decide(testCase.input, testCase.evidence, testCase.state)

      if (result.decision === 'allow') {
        continue
      }
      // "Make the minimal change" is the allow branch's instruction alone. It
      // must never appear on a verdict that forbids the edit.
      expect(result.nextSteps.join(' ')).not.toMatch(/make the (minimal )?change/i)
    }
  })

  it('tells the agent to keep the change minimal on allow', () => {
    const result = decide(
      makeInput({ reproduction: { command: 'npm' } }),
      evidence('reproduced', { exitCode: 1 }),
      state(),
    )

    expect(result.decision).toBe('allow')
    expect(result.nextSteps.join(' ')).toMatch(/minimal/i)
    expect(result.nextSteps.join(' ')).toMatch(/do not refactor/i)
  })
})

describe('decide: allow reachability', () => {
  const EVIDENCE_STATES: Evidence['state'][] = [
    'reproduced',
    'not_reproduced',
    'unverifiable',
    'timeout',
  ]
  const TREES: StateInfo['workingTree'][] = ['clean', 'dirty', 'unknown']
  const TESTS: StateInfo['tests'][] = ['pass', 'fail', 'skipped', 'unknown']

  it('never allows anything unless a non-zero failure was reproduced on a clean tree', () => {
    const unjustified: string[] = []

    // Every combination of what the agent supplied, what the reproduction
    // found, and what the repository looked like. `reproduced` is always paired
    // with a real non-zero exit code, because rule 5a'' denies anything else.
    for (const withText of [false, true]) {
      for (const withReproduction of [false, true]) {
        for (const runTests of [false, true]) {
          for (const evidenceState of EVIDENCE_STATES) {
            for (const workingTree of TREES) {
              for (const tests of TESTS) {
                const input = makeInput({
                  ...(withText ? { evidenceOfProblem: 'It crashes on start-up.' } : {}),
                  ...(withReproduction ? { reproduction: { command: 'npm' } } : {}),
                  runTests,
                })

                const result = decide(
                  input,
                  evidenceState === 'reproduced'
                    ? evidence(evidenceState, { exitCode: 1 })
                    : evidence(evidenceState),
                  state({ workingTree, tests }),
                )

                // The single combination the policy is allowed to approve.
                const justified =
                  evidenceState === 'reproduced' &&
                  workingTree === 'clean' &&
                  (!runTests || tests !== 'pass')

                if (result.decision === 'allow' && !justified) {
                  unjustified.push(`${evidenceState}/${workingTree}/${tests}/runTests=${runTests}`)
                }
              }
            }
          }
        }
      }
    }

    expect(unjustified).toEqual([])
  })

  it('reaches allow through exactly one evidence state', () => {
    const allowing = EVIDENCE_STATES.filter(
      (evidenceState) =>
        decide(
          makeInput({ reproduction: { command: 'npm' } }),
          evidenceState === 'reproduced'
            ? evidence(evidenceState, { exitCode: 1 })
            : evidence(evidenceState),
          state(),
        ).decision === 'allow',
    )

    expect(allowing).toEqual(['reproduced'])
  })

  it('requires a clean tree even when the reproduction is valid', () => {
    for (const workingTree of ['dirty', 'unknown'] as const) {
      const result = decide(
        makeInput({ reproduction: { command: 'npm' } }),
        evidence('reproduced', { exitCode: 1 }),
        state({ workingTree }),
      )

      expect(result.decision).toBe('request_info')
    }
  })

  it('never allows a zero exit, whatever the agent declared it expected', () => {
    // Defence in depth. Stage 1 already refuses to report `reproduced` for a
    // zero exit; this pins the property at the point where permission is
    // actually granted, so an upstream change cannot quietly reopen it.
    const unjustified: string[] = []

    for (const expectFailure of [true, false]) {
      for (const withText of [false, true]) {
        for (const runTests of [false, true]) {
          for (const workingTree of TREES) {
            for (const tests of TESTS) {
              const input = makeInput({
                reproduction: { command: 'npm', expectFailure },
                ...(withText ? { evidenceOfProblem: 'It crashes on start-up.' } : {}),
                runTests,
              })

              const result = decide(
                input,
                evidence('reproduced', { exitCode: 0 }),
                state({ workingTree, tests }),
              )

              if (result.decision === 'allow') {
                unjustified.push(
                  `expectFailure=${expectFailure}/text=${withText}/runTests=${runTests}/${workingTree}/${tests}`,
                )
              }
            }
          }
        }
      }
    }

    expect(unjustified).toEqual([])
  })

  it('only allows when a genuine non-zero exit was actually observed', () => {
    // Exhaustive over the exit-code shapes a closed child can produce. Zero and
    // "no code at all" both mean nothing failed, so neither may reach `allow`.
    for (const exitCode of [0, 1, 2, 127, undefined]) {
      const result = decide(
        makeInput({ reproduction: { command: 'npm' } }),
        evidence('reproduced', exitCode === undefined ? {} : { exitCode }),
        state(),
      )

      if (exitCode === undefined) {
        expect(result.decision, 'no exit code observed').not.toBe('allow')
        continue
      }
      expect(result.decision, `exitCode=${exitCode}`).toBe(exitCode === 0 ? 'deny' : 'allow')
    }
  })
})

describe('decide: the allow reason describes the evidence that caused it', () => {
  it('reports the observed exit code on an allow', () => {
    const result = decide(
      makeInput({ reproduction: { command: 'npm' } }),
      evidence('reproduced', { exitCode: 1 }),
      state(),
    )

    expect(result.decision).toBe('allow')
    expect(result.reason).toContain('1')
    expect(result.reason).toMatch(/failed as declared/i)
  })

  it('never claims a failure was reproduced when the command succeeded', () => {
    // The exact defect from the security report: the old rule 5c reason read
    // "Failure reproduced under a clean working tree" on a path where the
    // command had exited zero.
    for (const expectFailure of [true, false]) {
      const result = decide(
        makeInput({ reproduction: { command: 'npm', expectFailure } }),
        evidence('reproduced', { exitCode: 0 }),
        state(),
      )

      expect(result.decision, `expectFailure=${expectFailure}`).not.toBe('allow')
      expect(result.reason, `expectFailure=${expectFailure}`).not.toMatch(/failure reproduced/i)
      expect(result.reason, `expectFailure=${expectFailure}`).toMatch(
        /did not fail|not evidence|successful/i,
      )
    }
  })

  it('does not claim a reproduced failure on any non-allow verdict', () => {
    for (const testCase of CASES) {
      const result = decide(testCase.input, testCase.evidence, testCase.state)

      if (result.decision === 'allow') {
        continue
      }
      expect(result.reason, testCase.name).not.toMatch(/failure reproduced/i)
    }
  })
})

describe('decide: logging', () => {
  it('logs every verdict at info level with the decision and reason', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger)

    for (const testCase of CASES) {
      const result = decide(testCase.input, testCase.evidence, testCase.state)
      const call = spy.mock.calls.at(-1)

      expect(call?.[0]).toMatchObject({
        decision: result.decision,
        reason: result.reason,
      })
      expect(call?.[1]).toBe('pre_action_check decision')
    }

    expect(spy).toHaveBeenCalledTimes(CASES.length)
    spy.mockRestore()
  })

  it('logs allow verdicts as well as refusals', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => logger)

    const result = decide(
      makeInput({ reproduction: { command: 'npm' } }),
      evidence('reproduced', { exitCode: 1 }),
      state(),
    )

    expect(result.decision).toBe('allow')
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ decision: 'allow' })
    spy.mockRestore()
  })
})
