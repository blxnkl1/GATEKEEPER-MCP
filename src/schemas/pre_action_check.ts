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
 * Commands the gatekeeper refuses to run as a reproduction.
 *
 * The reproduction runner never uses a shell, so these entries cannot be smuggled
 * in via metacharacters. They are refused because a "reproduction" that destroys
 * the machine is not evidence of anything, and an agent asking for `rm` has
 * already lost the thread of the task.
 *
 * The interpreters are here for a different reason. `bash -c "…"` is a shell by
 * another name, so allowing `bash` while refusing `curl … | sh` is incoherent:
 * the pattern denylist below exists precisely because piping a downloaded script
 * into a shell is arbitrary code execution by construction, and `bash -c` walks
 * straight past it. The same argument applies to the script hosts — an agent can
 * run any program through `python -c` or `perl -e` just as easily.
 *
 * This is a refusal list, not a sandbox. It raises the cost of casual misuse and
 * it closes the obvious interpreter bypass; it does not make the child process
 * harmless. See the "Execution Boundary" section of `docs/architecture.md` for
 * what is and is not constrained.
 */
export const DEFAULT_DENYLISTED_COMMANDS = [
  'rm',
  'dd',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'fdisk',
  'parted',
  'chown',
  'chmod',
  'sudo',
  'su',
  'kill',
  'killall',
  // Shells and script hosts. A reproduction should be the project's own
  // verification command, not an interpreter handed a program string.
  'sh',
  'bash',
  'zsh',
  'ksh',
  'dash',
  'csh',
  'tcsh',
  'fish',
  'env',
  'xargs',
  'eval',
  'exec',
  'nohup',
  'setsid',
  'script',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'php',
  'lua',
  'osascript',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  'ssh',
  'scp',
  'sftp',
  'rsync',
] as const

/**
 * Patterns that refuse a command regardless of its basename.
 *
 * `curl ... | sh` is the important one: piping a downloaded script into a shell
 * is arbitrary code execution by construction, and no real reproduction needs it.
 */
export const DEFAULT_DENYLISTED_PATTERNS = [
  'rm\\s+-rf\\s+/',
  'curl.*\\|.*sh',
  'wget.*\\|.*sh',
  '>\\s*/dev/sd',
] as const

/** A denylist as it arrives from configuration. */
export interface Denylist {
  commands: string[]
  patterns: string[]
}

/** The denylist used when no configuration file supplies one. */
export const DEFAULT_DENYLIST: Denylist = {
  commands: [...DEFAULT_DENYLISTED_COMMANDS],
  patterns: [...DEFAULT_DENYLISTED_PATTERNS],
}

/**
 * Explains why a reproduction is refused, or returns null when it is acceptable.
 *
 * Both the command and its arguments are inspected, joined into one line. A
 * pattern check on the command alone is not enough: `curl` on its own is
 * harmless, while the dangerous form is `curl <url> | sh`, which arrives as a
 * command plus arguments and would otherwise pass.
 *
 * @param command The executable, as supplied by the agent.
 * @param denylist The active denylist.
 * @param args Its arguments, as supplied by the agent.
 * @returns A human-readable refusal, or null when the command is allowed.
 */
export function denylistReason(
  command: string,
  denylist: Denylist,
  args: readonly string[] = [],
): string | null {
  const basename = command.split('/').pop() ?? command

  if (denylist.commands.includes(basename)) {
    return `Command "${basename}" is on the denylist. Use a command that inspects or tests the code instead of one that changes the system.`
  }

  const line = [command, ...args].join(' ')
  for (const pattern of denylist.patterns) {
    if (matchesPattern(line, pattern)) {
      return `Command "${line}" matches a denied pattern (${pattern}). Shell pipelines and destructive operations are refused.`
    }
  }

  return null
}

/**
 * Matches a command against a denylist pattern.
 *
 * Patterns come from a config file the user can edit, so a broken regex must not
 * throw and take the session down. An invalid pattern is treated as no match,
 * which fails open for that one pattern; the basename denylist still applies.
 *
 * @param command The command string to test.
 * @param pattern A regular expression source string.
 * @returns Whether the pattern matches.
 */
function matchesPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(command)
  } catch {
    return false
  }
}

/**
 * Builds the reproduction schema for a given denylist.
 *
 * A factory, because the denylist is configuration and configuration is read at
 * startup. The default export below is what the MCP tool metadata advertises.
 *
 * @param denylist The active denylist.
 * @returns A reproduction schema that refuses denied commands.
 */
export function createReproductionSchema(denylist: Denylist) {
  return baseReproductionSchema().superRefine((value, ctx) => {
    const refusal = denylistReason(value.command, denylist, value.args)
    if (refusal !== null) {
      // Denied commands are a hard stop. A refused command never reaches the
      // engine, so nothing is ever spawned.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: refusal })
    }
  })
}

/**
 * The reproduction shape without any denylist check.
 *
 * This is what the tool advertises over MCP, and it is deliberate. The MCP SDK
 * validates `arguments` against the advertised schema *before* the tool handler
 * runs, so folding the denylist in here meant a denied command was rejected at
 * the protocol layer and the handler never saw it — which made
 * `denylist_rejected` unreachable for the built-in list, leaving the audit trail
 * blind to the most common security rejection. Enforcing the denylist in the
 * handler instead means every rejection is both explained to the agent and
 * recorded.
 *
 * @returns A shape-only reproduction schema.
 */
export function createReproductionShape() {
  return baseReproductionSchema()
}

/** The field-level reproduction schema, before any denylist refinement. */
function baseReproductionSchema() {
  return z.object({
    command: z.string().min(1).describe('Bare executable to run, e.g. "npm", "pytest", "node".'),
    args: z
      .array(z.string())
      .default([])
      .describe('Arguments for the executable. Defaults to []. Do NOT put arguments in `command`.'),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe('Working directory. Must be inside the repository root.'),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe('Kill the command after this many milliseconds. Default 30000, max 300000.'),
    expectFailure: z
      .boolean()
      .optional()
      .describe(
        'Descriptive only: records whether you expected this command to fail today. ' +
          'It CANNOT change the verdict. Only a non-zero exit is ever treated as failure ' +
          'evidence, so a command that exits 0 is never a reproduced failure whatever you ' +
          'pass here.',
      ),
  })
}

/**
 * An executable reproduction of the reported problem.
 *
 * The command is spawned directly, never through a shell, so `command` must be
 * a bare executable and every argument belongs in `args`. An agent that writes
 * `command: "npm test"` is rejected and told to split it, because accepting the
 * string would mean handing it to a shell, and a shell is precisely the thing
 * the safety model refuses to introduce.
 */
export const reproductionSchema = createReproductionShape()

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
} as const

/**
 * The old `runTests` flag has been removed.
 *
 * It used to let the agent decide whether the gate cross-checked its own claim,
 * which combined with the agent also choosing the reproduction command to make
 * `allow` free: `{"command":"false"}` on a clean tree was approved because
 * nothing ever ran the project's tests. The verification command is now run by
 * the server whenever it can change the verdict, and `allow` additionally
 * requires it to have failed. Agents still sending `runTests` are unaffected:
 * the field is stripped rather than rejected.
 */

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

/**
 * The wire response: the engine's verdict plus a nonce.
 *
 * The nonce lives here rather than in {@link preActionCheckOutputSchema} on
 * purpose. It is not a policy decision, it is a statement about this particular
 * reply to this particular caller, and the engine is frozen: it must not know
 * about transports. The tool layer stamps the nonce onto the engine's verdict,
 * and {@link verify_decision} is what later checks that the agent reported the
 * decision it was actually given.
 */
export const preActionCheckResponseSchema = preActionCheckOutputSchema.extend({
  nonce: z
    .string()
    .min(1)
    .describe('Opaque single-use token. Pass it to verify_decision before reporting the decision.'),
})

/** Parsed, validated `pre_action_check` input. */
export type PreActionCheckInputParsed = z.infer<typeof preActionCheckInputSchema>

/** Parsed, validated `pre_action_check` output. */
export type PreActionCheckOutputParsed = z.infer<typeof preActionCheckOutputSchema>
