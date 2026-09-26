/**
 * Analysis pipeline.
 *
 * Orchestrates the three gatekeeper stages in a fixed order and short-circuits
 * as soon as a stage produces a verdict that cannot change. The order is
 * cheapest and most decisive first, so the common case of a disproven or
 * entirely unevidenced change is rejected without ever inspecting the
 * repository.
 *
 * All side effects are injected through {@link Deps}, so the whole pipeline can
 * be driven in a test without spawning a process or running real git.
 */

import { exec, spawn } from 'node:child_process'

import { logger } from '../logger.js'
import type { Deps, PreActionCheckInput, PreActionCheckOutput, StateInfo } from '../types/index.js'
import { decide } from './decision.js'
import { runReproduction } from './reproduction.js'
import { inspectState } from './state.js'

/**
 * The production dependency set, built from Node built-ins.
 *
 * `exec` is present but unused by design: see the note on {@link Deps.exec}.
 */
export const realDeps: Deps = {
  spawn,
  // `node:child_process` is imported for its types as well, so the unused binding
  // is intentional and would be a bug if the engine ever called it.
  exec,
  cwd: () => process.cwd(),
  now: () => Date.now(),
}

/**
 * State reported when stage 2 is skipped.
 *
 * Nothing was inspected, so nothing may be claimed. `workingTree: 'unknown'`
 * is deliberately not `clean`: the decision engine treats unknown as a
 * non-clean tree, which keeps a short-circuited call from ever reaching `allow`.
 */
const SKIPPED_STATE: StateInfo = {
  workingTree: 'unknown',
  tests: 'skipped',
  detail: 'skipped',
}

/**
 * Whether stage 2 can be skipped.
 *
 * Skipped when the verdict is already fixed regardless of repository state: a
 * reproduction that passed proves the change unjustified (rule 1 denies), and
 * having no evidence at all proves it unjustified (rule 2 denies). Running git
 * and possibly a test suite to then throw that work away is pure cost. The
 * `unverifiable`-with-text-evidence case is not short-circuited, because that
 * path is `request_info` and the state detail is still useful to the user.
 *
 * @param evidence Result of the reproduction stage.
 * @param input Validated tool input.
 * @returns Whether the state inspection stage may be skipped.
 */
function canSkipState(
  evidence: PreActionCheckOutput['evidence'],
  input: PreActionCheckInput,
): boolean {
  if (evidence.state === 'not_reproduced') {
    return true
  }
  const hasTextEvidence =
    input.evidenceOfProblem !== undefined && input.evidenceOfProblem.trim() !== ''
  return evidence.state === 'unverifiable' && !hasTextEvidence
}

/**
 * Runs the full gatekeeper pipeline for a proposed change.
 *
 * 1. {@link runReproduction} - execute the agent's reproduction, if any.
 * 2. {@link inspectState} - establish the working tree and, on request, the
 *    test suite result. Skipped when stage 1 already fixes the verdict.
 * 3. {@link decide} - apply the policy to the collected facts.
 *
 * @param input Validated `pre_action_check` input.
 * @param deps Injected dependencies. Defaults to the real Node built-ins.
 * @returns The final decision, reason, next steps, and supporting evidence.
 */
export async function analyze(
  input: PreActionCheckInput,
  deps: Deps = realDeps,
): Promise<PreActionCheckOutput> {
  const evidence = await runReproduction(input, deps)
  const skipState = canSkipState(evidence, input)
  const state = skipState ? SKIPPED_STATE : await inspectState(input, deps)

  if (skipState) {
    logger.debug('analyze: state inspection skipped, verdict is already determined')
  } else {
    logger.debug({ workingTree: state.workingTree, tests: state.tests }, 'analyze: state inspected')
  }

  return decide(input, evidence, state)
}
