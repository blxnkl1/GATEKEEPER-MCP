/**
 * Domain types for GATEKEEPER MCP.
 *
 * This module is the single place where the analysis vocabulary is spelled out.
 * The runtime validation of the same shapes lives in `src/schemas/`, and the
 * types below are derived from those schemas so that the two can never drift.
 * Engine-facing types (the intermediate stage outputs and the injected
 * dependencies) are declared here because they are internal to the analysis
 * pipeline and are never sent over the wire.
 */

import type { exec, spawn } from 'node:child_process'
import type { z } from 'zod'

import type {
  preActionCheckInputSchema,
  preActionCheckOutputSchema,
} from '../schemas/pre_action_check.js'

/** Input accepted by the `pre_action_check` tool. */
export type PreActionCheckInput = z.infer<typeof preActionCheckInputSchema>

/** Output returned by the `pre_action_check` tool. */
export type PreActionCheckOutput = z.infer<typeof preActionCheckOutputSchema>

/**
 * What a `pre_action_check` result carries.
 *
 * Identical to {@link PreActionCheckOutput}; named separately because that is
 * what the decision engine returns, and the policy reads more clearly against
 * the shorter name.
 */
export type Decision = PreActionCheckOutput

/**
 * The three outcomes the gatekeeper can produce.
 *
 * - `allow`: the change is justified by evidence, proceed with the edit.
 * - `deny`: the change is not justified, do not touch any file.
 * - `request_info`: evidence is missing, the user must supply it first.
 */
export type DecisionKind = PreActionCheckOutput['decision']

/**
 * Outcome of the reproduction stage.
 *
 * `state` is the load-bearing field. Only `reproduced` can ever lead to
 * `allow`; every other value either denies or asks for more information.
 */
export type Evidence = PreActionCheckOutput['evidence']

/** Result of the state inspection stage. */
export type StateInfo = PreActionCheckOutput['state']

/**
 * Injected dependencies for the engine.
 *
 * Every side effect the engine performs goes through this object, so a test can
 * drive the whole pipeline without spawning a real process, running real git, or
 * waiting on a real clock. `analyzer.ts` builds the production implementation
 * from Node built-ins; tests supply fakes.
 */
export interface Deps {
  /**
   * Process spawner used for every command the engine runs.
   *
   * Always invoked with `shell: false`. See the reproduction safety model.
   */
  spawn: typeof spawn
  /**
   * Declared for completeness but deliberately never used.
   *
   * `exec` always runs its argument through a shell, which is exactly what the
   * reproduction safety model forbids. Keeping the member on this interface
   * lets a test inject a throwing `exec` and prove the engine has no shell code
   * path at all.
   */
  exec: typeof exec
  /** Working directory that acts as the repository root and path sandbox. */
  cwd: () => string
  /** Monotonic-ish clock used to measure command durations. */
  now: () => number
}

/** Options accepted by {@link createServer}, useful for tests. */
export interface ServerOptions {
  /** Overrides the server version reported during MCP initialization. */
  version?: string
}
