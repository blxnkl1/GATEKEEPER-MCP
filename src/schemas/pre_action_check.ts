/**
 * Zod schemas for the `pre_action_check` tool.
 *
 * These schemas are the runtime source of truth: every tool input is validated
 * on the way in and every tool output is validated on the way out, so an agent
 * can never hand us an untyped payload. TypeScript types for both shapes are
 * inferred from the schemas in `src/types/index.ts`.
 *
 * Validation here is strict on purpose. Bounds that an agent could plausibly get
 * wrong, such as `timeoutMs`, are rejected at the boundary with a precise error
 * rather than being silently corrected, because a silent clamp turns a
 * misunderstood parameter into a mysterious timeout. The engine clamps as well,
 * as defence in depth for callers that bypass this boundary.
 */

import { z } from 'zod'

/**
 * The three decisions the gatekeeper is allowed to return.
 *
 * Kept as a tuple so the generated JSON schema preserves ordering.
 */
export const decisionValues = ['allow', 'deny', 'request_info'] as const

/** Enum of the permitted gatekeeper decisions. */
export const decisionSchema = z.enum(decisionValues)

/** Lowest accepted reproduction timeout, in milliseconds. */
export const MIN_TIMEOUT_MS = 1000

/** Highest accepted reproduction timeout, in milliseconds. */
export const MAX_TIMEOUT_MS = 300000

/** Default reproduction timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30000

/**
 * An executable reproduction of the reported problem.
 *
 * The command is spawned directly, never through a shell, so `command` must be
 * a bare executable and every argument belongs in `args`. An agent that writes
 * `command: "npm test"` is rejected and told to split it, because accepting the
 * string would mean handing it to a shell, and a shell is precisely the thing
 * the safety model refuses to introduce.
 */
export const reproductionSchema = z.object({
  /** Bare executable to run, for example "npm", "pytest", or "node". */
  command: z.string().min(1).describe('Bare executable to run, e.g. "npm", "pytest", "node".'),
  /** Arguments passed to the executable. Defaults to an empty list. */
  args: z
    .array(z.string())
    .default([])
    .describe('Arguments for the executable. Defaults to []. Do NOT put arguments in `command`.'),
  /**
   * Working directory for the command. Must resolve inside the repository root.
   * Defaults to the current working directory.
   */
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe('Working directory. Must be inside the repository root.'),
  /**
   * How long to wait before killing the command, in milliseconds.
   * Defaults to 30000, and is clamped to the range 1000 to 300000.
   */
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe('Kill the command after this many milliseconds. Default 30000, max 300000.'),
  /**
   * How to read the exit code. Defaults to true, meaning "this command is
   * expected to fail today and pass once the bug is fixed". Set false for a
   * command that is expected to succeed, such as an assertion that currently
   * holds and the change would break.
   */
  expectFailure: z
    .boolean()
    .optional()
    .describe(
      'When true (default) a non-zero exit means reproduced. When false, invert: a zero exit means reproduced.',
    ),
})

/**
 * Raw shape of a `pre_action_check` tool call.
 *
 * `taskDescription` and `proposedChange` are the only required fields: the
 * agent must at least state what it wants to do before asking for permission.
 * Everything else is evidence, and evidence is optional by design so that a
 * missing field can be turned into an explicit gate rather than a crash.
 */
export const preActionCheckInputShape = {
  /** What the agent is trying to accomplish, in its own words. */
  taskDescription: z.string().min(1).describe('What the agent is trying to accomplish.'),
  /** The diff, or a natural-language description, of the proposed change. */
  proposedChange: z
    .string()
    .min(1)
    .describe('The diff, or a natural-language description, of the proposed change.'),
  /** Files the agent intends to touch. Optional. */
  affectedFiles: z
    .array(z.string().min(1))
    .optional()
    .describe('Files the agent intends to modify.'),
  /**
   * Free-text proof that a problem exists: reproduction steps, a failing test,
   * an error log. Optional. On its own it is not executable, so it can only ever
   * lead to `request_info`; pair it with `reproduction` to be able to `allow`.
   */
  evidenceOfProblem: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Free-text proof that a problem exists. Not executable on its own; ' +
        'supply `reproduction` to obtain an allow decision.',
    ),
  /** An executable reproduction of the problem. Optional. */
  reproduction: reproductionSchema
    .optional()
    .describe('An executable command that reproduces the problem.'),
  /**
   * Whether to run the project's test suite as additional evidence. Defaults to
   * false, because running a suite is expensive and most calls do not need it.
   */
  runTests: z
    .boolean()
    .optional()
    .describe('Run the project test suite as extra evidence. Default false.'),
} as const

/**
 * Raw shape of a `pre_action_check` tool result.
 *
 * `nextSteps` is an array rather than a single string so that an agent can
 * follow a multi-step recovery path without re-parsing prose. `evidence` and
 * `state` are included so the agent can see the facts behind the verdict instead
 * of taking it on faith.
 */
export const preActionCheckOutputShape = {
  /** The verdict for the proposed change. */
  decision: decisionSchema.describe('The verdict for the proposed change.'),
  /** One or two sentences explaining the verdict. */
  reason: z.string().min(1).describe('One or two sentences explaining the verdict.'),
  /** Ordered, actionable instructions for the agent. */
  nextSteps: z.array(z.string().min(1)).describe('Ordered, actionable instructions.'),
  /** What the reproduction stage found. */
  evidence: z
    .object({
      state: z
        .enum(['reproduced', 'not_reproduced', 'unverifiable', 'timeout'])
        .describe('Outcome of the reproduction attempt.'),
      detail: z.string().min(1).describe('Human-readable explanation, safe to show to the user.'),
      exitCode: z.number().int().optional().describe('Exit code, present only when a command ran.'),
      durationMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('How long the command took, in milliseconds.'),
    })
    .describe('What the reproduction stage found.'),
  /** What the state inspection stage found. */
  state: z
    .object({
      workingTree: z.enum(['clean', 'dirty', 'unknown']).describe('Git working tree status.'),
      tests: z.enum(['pass', 'fail', 'skipped', 'unknown']).describe('Result of the test suite.'),
      detail: z.string().min(1).describe('Human-readable explanation, safe to show to the user.'),
    })
    .describe('What the state inspection stage found.'),
} as const

/** Validated `pre_action_check` tool call. */
export const preActionCheckInputSchema = z.object(preActionCheckInputShape)

/** Validated `pre_action_check` tool result. */
export const preActionCheckOutputSchema = z.object(preActionCheckOutputShape)

/** Parsed, validated `pre_action_check` input. */
export type PreActionCheckInputParsed = z.infer<typeof preActionCheckInputSchema>

/** Parsed, validated `pre_action_check` output. */
export type PreActionCheckOutputParsed = z.infer<typeof preActionCheckOutputSchema>
