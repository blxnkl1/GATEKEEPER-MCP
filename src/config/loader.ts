/**
 * Configuration loading.
 *
 * Resolution order, first match wins:
 *   1. the file named by $GATEKEEPER_CONFIG
 *   2. .gatekeeperrc.json in the current working directory
 *   3. ~/.gatekeeperrc.json
 *   4. built-in defaults
 *
 * An unreadable or invalid file is a hard error. Silently falling back to
 * defaults would mean a user who deliberately configured `mode: "enforced"`
 * could end up running advisory after a typo, and nothing would tell them. That
 * is precisely the class of quiet downgrade this project exists to prevent, so a
 * bad config stops the server with a message on stderr instead.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

import { DEFAULT_DENYLIST, MAX_TIMEOUT_MS } from '../schemas/pre_action_check.js'
import { DEFAULT_NONCE_STORE_OPTIONS } from '../store/nonce-store.js'

/** How aggressively the server holds an agent to the decision sequence. */
export type Mode = 'advisory' | 'enforced'

/** Sliding-window request budget. */
export const rateLimitSchema = z
  .object({
    windowMs: z.number().int().positive().default(60_000),
    max: z.number().int().positive().default(20),
  })
  .strict()

/** Commands and patterns the reproduction runner refuses. */
export const denylistSchema = z
  .object({
    commands: z.array(z.string().min(1)).default([...DEFAULT_DENYLIST.commands]),
    patterns: z.array(z.string().min(1)).default([...DEFAULT_DENYLIST.patterns]),
  })
  .strict()

/** Local audit log settings. */
export const auditLogSchema = z
  .object({
    enabled: z.boolean().default(false),
    path: z.string().min(1).default('~/.gatekeeper/audit.log'),
  })
  .strict()

/**
 * The project's own verification command, as an argv array.
 *
 * Declared by the operator, never by the agent. This matters: the decision
 * engine treats a failing verification surface as the decisive evidence for
 * `allow`, so the command that produces that signal must not be something the
 * caller of the tool can choose. It is an argv array rather than a string so
 * that configuring it never introduces a shell.
 */
export const testCommandSchema = z
  .array(z.string().min(1))
  .min(1)
  .optional()
  .describe(
    'Argv of the project verification command, e.g. ["pytest","-q"]. ' +
      'When unset it is detected from the lockfile and package.json.',
  )

/** Nonce store limits. */
export const nonceStoreSchema = z
  .object({
    maxSize: z.number().int().positive().default(DEFAULT_NONCE_STORE_OPTIONS.maxSize),
    ttlMs: z.number().int().positive().default(DEFAULT_NONCE_STORE_OPTIONS.ttlMs),
  })
  .strict()

/** The whole configuration file. Unknown keys are rejected. */
export const configSchema = z
  .object({
    mode: z.enum(['advisory', 'enforced']).default('advisory'),
    rateLimit: rateLimitSchema.default({}),
    denylist: denylistSchema.default({}),
    auditLog: auditLogSchema.default({}),
    nonceStore: nonceStoreSchema.default({}),
    testCommand: testCommandSchema,
    testTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe('Ceiling for the verification command. Default 120000, max 300000.'),
  })
  .strict()

/** Fully resolved configuration, every field present. */
export type Config = z.infer<typeof configSchema>

/** Built-in defaults, used when no file is found. */
export const DEFAULT_CONFIG: Config = configSchema.parse({})

/** Thrown when a configuration file exists but cannot be used. */
export class ConfigError extends Error {
  /** The file that failed, when the failure is file-specific. */
  readonly path: string | undefined

  constructor(message: string, path?: string) {
    super(message)
    this.name = 'ConfigError'
    this.path = path
  }
}

/** Where the configuration came from, for logging. */
export interface LoadedConfig {
  config: Config
  /** Absolute path of the file used, or null when defaults applied. */
  source: string | null
}

/**
 * Expands a leading `~` and resolves the result.
 *
 * @param path A configured path, possibly starting with `~`.
 * @returns An absolute path.
 */
export function expandPath(path: string): string {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  return isAbsolute(path) ? path : resolve(path)
}

/**
 * Returns the candidate config paths in priority order.
 *
 * Exported so the search order is testable without touching the real home
 * directory, and so the CI job can show what was considered.
 *
 * @param cwd The working directory to look for a project config in.
 * @param home The home directory to look for a user config in.
 * @param env The environment to read for an explicit override.
 * @returns Existing paths, highest priority first.
 */
export function candidateConfigPaths(cwd: string, home: string, env: NodeJS.ProcessEnv): string[] {
  const override = env.GATEKEEPER_CONFIG
  const candidates = [
    ...(override === undefined || override === '' ? [] : [expandPath(override)]),
    join(cwd, '.gatekeeperrc.json'),
    join(home, '.gatekeeperrc.json'),
  ]
  return candidates.filter((path) => existsSync(path))
}

/**
 * Parses one config file.
 *
 * @param path Absolute path to read.
 * @param readFile Injection point for tests, so no file need exist on disk.
 * @returns The parsed configuration.
 * @throws ConfigError when the file is unreadable, is not JSON, or fails the schema.
 */
export function parseConfigFile(path: string, readFile?: (path: string) => string): Config {
  let raw: string
  try {
    raw = readFile === undefined ? readFileSync(path, 'utf8') : readFile(path)
  } catch (error) {
    throw new ConfigError(
      `Cannot read config file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    )
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(
      `Config file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      path,
    )
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(`Config file ${path} is invalid: ${issues}`, path)
  }

  return result.data
}

/**
 * Loads the configuration.
 *
 * @param overrides Injection points for tests.
 * @returns The resolved config and the file it came from.
 * @throws ConfigError when a candidate file exists but is unusable.
 */
export function loadConfig(
  overrides: {
    cwd?: string
    home?: string
    env?: NodeJS.ProcessEnv
    readFile?: (path: string) => string
  } = {},
): LoadedConfig {
  const cwd = overrides.cwd ?? process.cwd()
  const home = overrides.home ?? homedir()
  const env = overrides.env ?? process.env

  const candidates = candidateConfigPaths(cwd, home, env)

  if (candidates.length === 0) {
    return { config: DEFAULT_CONFIG, source: null }
  }

  // Highest priority first, so the first candidate that exists is the one used.
  const path = candidates[0] as string
  return { config: parseConfigFile(path, overrides.readFile), source: path }
}

/**
 * Reports a configuration failure as a single stderr line.
 *
 * Kept out of the loader so that importing the loader never has the side effect
 * of writing to a stream, which keeps it testable and keeps stdout clean.
 *
 * @param error The error to render.
 * @returns The message, for the caller to emit on stderr.
 */
export function describeConfigError(error: unknown): string {
  if (error instanceof ConfigError) {
    return `gatekeeper-mcp: ${error.message}. Fix the file, or remove it to use defaults.`
  }
  return `gatekeeper-mcp: unexpected configuration failure: ${
    error instanceof Error ? error.message : String(error)
  }`
}
