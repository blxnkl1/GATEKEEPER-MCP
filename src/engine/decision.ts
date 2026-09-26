/**
 * Stage 3: decision engine.
 *
 * Takes the facts gathered by the earlier stages and turns them into the single
 * verdict the agent is allowed to act on, together with the reason and the
 * concrete next steps that should replace the edit it wanted to make.
 *
 * The policy below is the heart of the gatekeeper and is intentionally a flat,
 * ordered list of rules with no scoring, weighting, or heuristics. A verdict has
 * to be explainable in one sentence to someone who did not write the code, and
 * every branch is covered by a table-driven test.
 *
 * ## Reachability of `allow`
 *
 * `allow` is the only verdict that permits an edit, and it is reachable through
 * exactly one path: the reproduction was executed and produced the expected
 * outcome, the working tree is clean, and no green test suite contradicts the
 * reproduction. Every other combination denies or asks for more information.
 */

import { logger } from '../logger.js'
import type {
  Decision,
  DecisionKind,
  Evidence,
  PreActionCheckInput,
  StateInfo,
} from '../types/index.js'

/** A verdict plus the explanation the agent is given. */
interface Verdict {
  decision: DecisionKind
  reason: string
  nextSteps: string[]
}

/**
 * Whether the agent supplied any free-text evidence of a problem.
 *
 * @param input Validated tool input.
 * @returns True when non-empty free-text evidence is present.
 */
function hasTextEvidence(input: PreActionCheckInput): boolean {
  return input.evidenceOfProblem !== undefined && input.evidenceOfProblem.trim() !== ''
}

/**
 * Applies the gatekeeping policy to the collected stage results.
 *
 * Rules are evaluated in a fixed order and the first match wins. The ordering
 * runs from "the change is disproven" through "the change is unprovable" to
 * "the change is proven", so a single pass always yields the most decisive
 * applicable answer.
 *
 * One deliberate narrowing: `allow` additionally requires a **clean** working
 * tree, not merely a non-dirty one. An `unknown` tree means the gatekeeper could
 * not establish that the reproduction ran against committed code, which is
 * uncertainty, and this project resolves uncertainty by refusing. Without that
 * narrowing an unpacked tarball, or a directory where git is missing, would
 * receive an unconditional `allow`.
 *
 * @param input Validated tool input.
 * @param evidence Result of the reproduction stage.
 * @param state Result of the state inspection stage.
 * @returns The final decision, with a reason and actionable next steps.
 */
export function decide(input: PreActionCheckInput, evidence: Evidence, state: StateInfo): Decision {
  /**
   * Attaches the supporting facts to a verdict and records it.
   *
   * Every verdict passes through here, which is what guarantees both the "log
   * every decision" rule and the "always return the evidence" rule cannot be
   * forgotten when a branch is added.
   */
  const finalize = (verdict: Verdict): Decision => {
    logger.info(
      {
        decision: verdict.decision,
        reason: verdict.reason,
        evidenceState: evidence.state,
        workingTree: state.workingTree,
        tests: state.tests,
        evidenceSupplied: input.reproduction !== undefined,
      },
      'pre_action_check decision',
    )
    return { ...verdict, evidence, state }
  }

  // Rule 1: the reproduction ran and passed, so the bug is not there.
  if (evidence.state === 'not_reproduced') {
    return finalize({
      decision: 'deny',
      reason:
        'The reproduction command succeeded; no failure was observed. The code may already be correct.',
      nextSteps: [
        'Confirm the reproduction command actually exercises the bug.',
        'Provide a failing test or a command that exits non-zero on the bug.',
      ],
    })
  }

  // Rule 2: nothing at all was offered as evidence.
  if (evidence.state === 'unverifiable' && !hasTextEvidence(input)) {
    return finalize({
      decision: 'deny',
      reason:
        'No evidence of a problem was supplied. Changing code without evidence risks introducing unnecessary modifications.',
      nextSteps: [
        'Provide a failing test, an error log, or a reproduction command.',
        'If the task is a feature request (not a bug), state the acceptance criteria explicitly.',
      ],
    })
  }

  // Rule 3: a claim was made, but it cannot be executed and therefore not checked.
  if (evidence.state === 'unverifiable') {
    return finalize({
      decision: 'request_info',
      reason:
        'Free-text evidence was supplied, but it is not executable. Supply a command that fails on the bug.',
      nextSteps: [
        'Wrap the reproduction into an executable command.',
        'Or add a failing unit test.',
      ],
    })
  }

  // Rule 4: the command ran but never finished, so nothing was proven.
  if (evidence.state === 'timeout') {
    return finalize({
      decision: 'request_info',
      reason:
        'The reproduction command timed out. Narrow it down or increase timeoutMs (max 300000).',
      nextSteps: ['Reduce scope of the reproduction.', 'Increase timeoutMs if legitimately slow.'],
    })
  }

  // From here the reproduction was executed and behaved as the agent predicted.
  if (evidence.state === 'reproduced') {
    // Rule 5a: uncommitted changes make the observation untrustworthy.
    if (state.workingTree === 'dirty') {
      return finalize({
        decision: 'request_info',
        reason:
          'The failure is reproduced, but the working tree is dirty. Commit or stash unrelated changes first.',
        nextSteps: ['git stash or git commit the unrelated changes.', 'Re-run pre_action_check.'],
      })
    }

    // Rule 5a-prime: the tree state could not be established, so it is not clean.
    if (state.workingTree !== 'clean') {
      return finalize({
        decision: 'request_info',
        reason:
          'The failure is reproduced, but the working tree could not be verified as clean. Run this from a git repository with a clean working tree.',
        nextSteps: [
          'Run the check from inside the git repository for this project.',
          'Commit or stash any uncommitted changes, then re-run pre_action_check.',
        ],
      })
    }

    // Rule 5b: a green suite contradicts the reproduction, so one of them is wrong.
    if ((input.runTests ?? false) === true && state.tests === 'pass') {
      return finalize({
        decision: 'request_info',
        reason:
          'Existing tests pass despite the reproduction failing. Confirm that the reproduction and the test suite target the same behavior.',
        nextSteps: [
          'Check if the reproduction exercises code not covered by tests.',
          'Consider adding a failing test before changing source.',
        ],
      })
    }

    // Rule 5c: the only path to an approved edit.
    return finalize({
      decision: 'allow',
      reason: 'Failure reproduced under a clean working tree. The change is justified.',
      nextSteps: [
        'Make the minimal change that makes the reproduction pass.',
        'Do not refactor unrelated code.',
      ],
    })
  }

  // Rule 6: unreachable while the evidence union is exhaustive. Kept so that a
  // future state added to the union fails closed instead of falling through.
  return finalize({
    decision: 'request_info',
    reason:
      'Decision engine could not determine a policy outcome. This is a bug; please report it.',
    nextSteps: ['Do not modify any file.', 'Report this outcome as a gatekeeper bug.'],
  })
}
