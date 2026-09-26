# Architecture

## Overview

GATEKEEPER MCP is a local Model Context Protocol server that sits between a
coding agent and any code-modifying action. Before the agent edits a file it
calls the `pre_action_check` tool, which asks two questions: is there evidence
that a problem exists, and is the task already solved? If the answer to either
is no, the agent is instructed to stop and report back instead of editing. The
goal is not to write better code but to write less of it — specifically, to
suppress the unnecessary edits that make agents unsafe to run unattended.

## Design Goals

- **Local-only.** Everything runs in the agent's own process tree. No network
  calls, no telemetry, no remote policy service.
- **No network egress.** The server must work with the machine's network
  disabled. This is a hard constraint, not a default.
- **Agent-agnostic.** Any MCP host can drive it. Nothing in the code assumes a
  particular vendor, model, or agent framework.
- **STDIO transport.** Spawned as a child process, spoken to over stdin and
  stdout. No port to allocate, no daemon to supervise, no lifecycle to manage.
- **Fail closed.** When the server cannot prove a change is justified, the
  answer is never `allow`.
- **Explainable.** Every verdict carries a human-readable reason and concrete
  next steps, so the agent can recover without guessing.
- **Small surface.** Two tools, one pipeline, three stages. Anything that is not
  needed to answer "should I edit?" does not belong here.

## Non-Goals

- **Not a linter.** Style, formatting, and static analysis are Biome's and
  `tsc`'s job. Gatekeeper does not inspect code quality.
- **Not a code formatter.** Formatting is applied by a tool, not debated with
  an agent.
- **Not a CI replacement.** It runs inside a single agent session and has no
  knowledge of a pipeline, a branch, or a merge queue.
- **Not a test runner.** Phase 2 will *invoke* the project's own test suite as
  a source of evidence; it does not implement, discover, or own tests.
- **Not a code reviewer.** It does not judge style, architecture, or naming.
- **Not an autonomous agent.** It answers one question and returns. It never
  edits files itself.

## High-Level Diagram

```
                        JSON-RPC 2.0 over stdio
   +-------------+      (stdin -> / stdout <-)      +--------------------+
   |   Agent     | =================================> |   MCP Server      |
   | (MCP Host / |                                   |  (Gatekeeper)     |
   |  Client)    | <================================= |                    |
   +-------------+     result: allow|deny|request_info +---------+----------+
                                                               |
                                                               v
                                                     +---------+----------+
                                                     |  Analysis Engine  |
                                                     |  (src/engine/)    |
                                                     +---------+----------+
                                                               |
                     +-----------------------------------------+
                     |                                         |
                     v                                         v
          +----------+-----------+                 +-----------+-----------+
          | Reproduction Checker |                 |   State Inspector    |
          | (evidence of a      |                 | (git status, tests,  |
          |  problem?)          |                 |  already solved?)    |
          +----------+-----------+                 +-----------+-----------+
                     |  no evidence -> deny                     |
                     |  evidence -> continue                     |
                     +----------------------+--------------------+
                                            |
                                            v
                                 +----------+-----------+
                                 |  Decision Engine      |
                                 |  (policy rules)       |
                                 +----------+-----------+
                                            |
                          +-----------------+-----------------+
                          |                 |                 |
                          v                 v                 v
                     +--------+       +-----------+     +--------------+
                     | allow  |       |   deny    |     | request_info |
                     +--------+       +-----------+     +--------------+
```

Stage short-circuits: a `not_reproduced` or unevidenced `unverifiable` result
from the reproduction checker returns immediately, so the state inspector and
the decision engine are never reached and no process is spawned at all.

## Components

### `src/index.ts` — entrypoint

The process entrypoint and the only place that knows about a transport. It
creates the server, connects a `StdioServerTransport`, and installs SIGINT and
SIGTERM handlers so a host that kills the child does not leave a half-open
process. It parses no arguments and loads no configuration: a host controls the
lifetime, so the server has nothing to negotiate at startup.

### `src/server.ts` — server factory

Builds the `McpServer` with the name `gatekeeper-mcp` and the version read from
`package.json`, attaches server-level `instructions` telling the agent when to
call the gate, and registers every tool. It contains no transport logic, so
tests can build a fully wired server and connect it to an in-memory transport.

### `src/logger.ts` — logger

A single pino instance bound to `process.stderr`. See
[Logging Rule](#logging-rule) for why that binding is load-bearing rather than
cosmetic.

### `src/schemas/` — validation

Zod schemas for the tool's input and output, exported both as full objects and
as the raw property bags the MCP SDK expects. The schemas are the runtime source
of truth; the TypeScript types in `src/types/` are inferred from them, so the
two cannot drift apart.

### `src/types/` — domain types

Domain vocabulary shared across the engine: the `Decision` union, the two
inferred I/O shapes, the per-stage result interfaces, and the aggregate passed
to the decision stage. Plus `src/index.ts`'s own `ServerOptions`. This layer
contains no runtime code.

### `src/tools/pre_action_check.ts` — tool registration

The public surface. Declares the tool's name, description, input and output
schemas, and behaviour annotations, then runs `analyze()` and returns the
verdict. The description is written for the agent rather than for humans: it
states when to call the tool and what a denial obliges the agent to do.

### `src/engine/analyzer.ts` — pipeline

Orchestrates the three stages in a fixed, cheapest-first order and
short-circuits on the first blocking verdict. All policy ordering lives here;
no stage knows about any other stage.

### `src/engine/reproduction.ts` — stage 1

Decides whether the agent demonstrated that a problem exists, by executing the
supplied reproduction command and reading its exit code. This is the
highest-value check in the pipeline, because most unnecessary edits are attempts
to fix something that was never broken. Free text is never accepted as proof,
since prose cannot be verified and is as easy to fabricate as a change is to
justify. This module also owns `executeCommand`, the single hardened process
primitive described in [Reproduction Safety Model](#reproduction-safety-model),
which stage 2 reuses so that every guard is implemented once.

### `src/engine/state.ts` — stage 2

Establishes the working tree state via `git rev-parse` and `git status
--porcelain`, and, on request, runs the project test suite after detecting the
package manager from the lockfile. A dirty tree means a reproduction was observed
on top of uncommitted work and cannot be trusted; a green suite means the
reproduction and the suite disagree about what is broken. Both block an
approval.

### `src/engine/decision.ts` — stage 3

Applies the ordered policy to the collected facts and produces the final
verdict, logged at info level on the way out. This is the only place `allow` is
produced, and the only path to it is rule 5c. See
[ADR 0002](./decisions/0002-phase-2-decision-policy.md).

## Data Flow

1. The agent decides it is about to modify code and calls `pre_action_check`
   with `taskDescription`, `proposedChange`, and optionally `affectedFiles`,
   `evidenceOfProblem`, and `reproduction`.
2. The SDK receives the JSON-RPC `tools/call` request and validates `arguments`
   against the tool's input schema. A malformed call is rejected here, as a
   protocol-level validation error.
3. The handler re-parses the arguments with `preActionCheckInputSchema`, then
   calls `analyze(input, deps)`. Any failure after this point is caught and
   returned as a tool error with a safe message; no stack trace reaches the agent.
4. **Stage 1, reproduction.** `runReproduction` resolves the reproduction spec
   and applies the guards in [Reproduction Safety Model](#reproduction-safety-model).
   It returns an `Evidence` whose `state` is one of `reproduced`,
   `not_reproduced`, `unverifiable`, or `timeout`.
5. **Short-circuit check.** If the evidence is `not_reproduced`, or
   `unverifiable` with no free-text evidence, the verdict is already fixed and
   stage 2 is skipped entirely. No process is spawned and git is never consulted.
6. **Stage 2, state.** `inspectState` runs `git rev-parse --is-inside-work-tree`,
   then `git status --porcelain`, and derives `workingTree` as `clean`, `dirty`,
   or `unknown`. When the tree is clean and the evidence is `reproduced`, it also
   resolves the project's verification command — `testCommand` from the operator's
   configuration if set, otherwise the package manager detected from the lockfile
   plus `scripts.test` — and runs it, deriving `tests` as `pass`, `fail`, or
   `unknown`. It is not gated on any agent-supplied flag; see
   [ADR 0007](./decisions/0007-verification-command-decides-allow.md).
7. **Stage 3, decision.** `decide` applies the ordered policy. The first
   matching rule wins, and the verdict is logged at info level on the way out.
8. The handler validates the result against `preActionCheckOutputSchema` and
   returns it as both `content` (pretty-printed JSON text) and `structuredContent`.
9. The host passes the text to the model, which either proceeds (`allow`),
   stops and reports (`deny`), or asks the user for the missing evidence
   (`request_info`).

### Decision order

```
evidence = runReproduction(input, deps)

if evidence is not_reproduced            -> state = skipped, deny
if evidence is unverifiable, no text     -> state = skipped, deny
else                                     -> state = inspectState(input, deps)
                                          (verification runs when the evidence
                                           is reproduced and the tree is clean)

decide(input, evidence, state):
  1. not_reproduced                          -> deny
  2. unverifiable && !evidenceOfProblem      -> deny
  3. unverifiable && evidenceOfProblem       -> request_info
  4. timeout                                 -> request_info
  5. reproduced:
       5a.   workingTree = dirty              -> request_info
       5a'.  workingTree = unknown            -> request_info
       5a''  exitCode is 0 or absent          -> deny
       5b.   tests = pass                     -> request_info
       5b'.  tests is unknown or skipped      -> deny
       5c.   tests = fail                     -> allow
  6. otherwise                               -> request_info
```

`allow` is reachable only through rule 5c, which requires all four of: an
executed reproduction that exited non-zero, a verified clean working tree, a
verification command the server actually ran, and that command failing too. The
first two are the agent's claim. The last two are the part the agent does not
control, and they are what stop `{"command":"false"}` from buying an approval on
a healthy repository.

Rule 5a'' denies a zero or absent exit code, so a successful command is never
failure evidence whatever the agent declares. Rules 5a' and 5b' both resolve
uncertainty by refusing: a tree or a verification surface that could not be
established is not a clean tree and not a failing suite. See
[ADR 0002](./decisions/0002-phase-2-decision-policy.md) and
[ADR 0007](./decisions/0007-verification-command-decides-allow.md).

## Reproduction Safety Model

The engine executes a command supplied by the agent. That is the only place in
the project where untrusted input reaches the operating system, so every guard
lives in one function, `executeCommand` in `src/engine/reproduction.ts`, and
every caller goes through it. There is no second process-spawning path in the
codebase.

**`shell: false`, always.** The executable and its arguments are passed to the
OS verbatim; no shell ever parses them. This is the load-bearing control: with a
shell, `; | & $()` and friends in agent-supplied input would be interpreted, and
a description of a bug would become arbitrary code execution. `Deps.exec` is
declared on the interface and never called, precisely because `exec` always
spawns a shell; tests inject a throwing `exec` as a tripwire proving no shell
code path exists.

**No shell strings, even without a shell.** A `command` containing whitespace or
shell metacharacters is rejected as `unverifiable` with instructions to split it
into `command` plus `args`. With `shell: false` such a string is not an injection
risk today, but rejecting it means a future refactor that enables a shell cannot
silently become exploitable. The rejected set deliberately excludes `/`, since a
bare executable is often an absolute path.

**Confined working directory.** A supplied `cwd` is resolved against the
repository root and rejected if it lands outside it, so a reproduction cannot be
pointed at `/etc`, `$HOME`, or a sibling checkout. Both sides are resolved through
`realpath` first, so a symlink inside the repository that points outside it is
rejected rather than followed. A purely lexical comparison passed such a symlink,
and the child then really did run over there; that is fixed, and
`tests/security/allow-invariant.test.ts` pins it.

**Arguments are not confined, and this is not a sandbox.** Only `cwd` is
constrained. `args` are passed to the child verbatim, so a reproduction may read
any file the user can read — `{"command":"cat","args":["/etc/passwd"]}` runs, and
up to 200 characters of its output come back in the `detail` string. This is not
privilege escalation, because the agent could read those files with its own tools,
but it does mean "confined to the repository root" describes the working
directory and nothing more. It must not be read as filesystem containment.

**Interpreters are refused, and the list is not the control that protects the
invariant.** `sh`, `bash`, `zsh`, `env`, `python3`, `perl`, `ruby`, `php`,
`osascript`, `pwsh` and the network fetchers are all on the default denylist,
because `bash -c "…"` is a shell by another name and allowing it while refusing
`curl … | sh` would make the pattern denylist decorative. But `node` stays
allowed, because it is ordinary project tooling, and `node -e "…"` is a complete
interpreter in a single argument. A denylist cannot close that. What protects the
invariant is rule 5c: an interpreter that exits non-zero still cannot reach
`allow` unless the project's own verification command also fails.

**Closed stdin.** `stdio` is `['ignore', 'pipe', 'pipe']`. A reproduction that
reads stdin sees EOF instead of consuming the MCP host's JSON-RPC request stream,
which would otherwise corrupt the protocol mid-call.

**Capped output.** At most 16 KB of stdout and 16 KB of stderr are retained;
the rest is discarded. Without the cap, a command printing a megabyte, or
streaming without bound, would be buffered in full. Captured output is never
forwarded to stdout: stdout is the JSON-RPC channel, and captured output is
reduced to a short sanitized excerpt for the `detail` string, with ANSI escapes
and control characters stripped so it cannot rewrite a terminal.

**Bounded time.** `timeoutMs` defaults to 30000 and is clamped to the range
1000 to 300000. On expiry the child is killed with `SIGKILL`, which cannot be
caught or ignored, and the verdict is `timeout`. The engine does **not** wait for
the child to actually die: a gatekeeper that blocks an agent session on an
unresponsive child is worse than one that reports a timeout. The pending timer is
created with an `AbortSignal` and cancelled as soon as the command finishes,
because an abandoned five-minute timer would otherwise hold the event loop open.
The verification command has its own ceiling, `testTimeoutMs`, defaulting to
120000.

**Descendants are not reaped.** `SIGKILL` is delivered to the direct child only.
A reproduction that spawns a background daemon can leave it running after the
verdict is returned. This is a known limitation of killing a process rather than
a process group, and it is not fixed in v1.0.0.

## Execution Boundary

Stated precisely, because the difference between a gate and a sandbox is the
difference between a useful tool and a false claim.

**GATEKEEPER can constrain:**

- the *shape* of the command it spawns: one primitive, `shell: false`, a bare
  executable plus an argv array, stdin closed, output capped, time bounded;
- the *working directory*: resolved through `realpath` and required to be the
  repository root or beneath it;
- *which commands* are acceptable, via a denylist the operator can extend;
- *what the verdict may claim*, by requiring server-observed evidence for every
  term in the `allow` conjunction.

**GATEKEEPER cannot constrain:**

- **What the child process does.** No seccomp, no namespace, no chroot, no
  resource limits beyond output length. A permitted command can read any file the
  user can read, write any file the user can write, and open network connections.
- **Which files the child touches.** `args` are unconstrained; see above.
- **Network egress by the child.** GATEKEEPER itself opens no socket, but it will
  happily run a command that does. The accurate claim is: *GATEKEEPER itself
  performs no network egress; reproduction commands may execute according to the
  configured execution policy.* Network fetchers are on the default denylist to
  reduce that, not to eliminate it — `node -e` still reaches the network.
- **Whether a failure corresponds to the bug the agent described.** See
  [ADR 0007](./decisions/0007-verification-command-decides-allow.md).
- **Whether the agent edits a file after a `deny`.** MCP is request/response over
  stdio; the server has no channel to the filesystem the agent writes through.

## Transport Decision

GATEKEEPER MCP uses **STDIO** and does not offer HTTP or SSE.

- **Lifecycle matches the host.** An MCP host already spawns and reaps local
  server processes. STDIO reuses that machinery, so there is no port to
  allocate, no daemon to keep alive, and nothing to clean up on crash.
- **No listening socket.** Binding a port exposes the server to the local
  network and creates a class of problems (port collisions, authentication,
  accidental cross-session state) for zero benefit in the intended topology,
  where the host and the server are on the same machine by construction.
- **Process isolation is a feature.** Each agent session gets its own process
  and its own module state, so one session's findings can never leak into
  another's.
- **No authentication needed.** Trust is established by the parent process
  relationship, not by a token.
- **It is the MCP default.** Local servers are expected to speak STDIO, so the
  server works with every host without host-specific configuration.

HTTP or SSE would only be justified if the server had to serve several
unrelated clients from one place, which contradicts the local-only goal.

## Logging Rule

**stdout is reserved for the JSON-RPC frame stream. All logging goes to stderr.**

This is the single most important invariant in the codebase. The host reads
stdout and parses it as newline-delimited JSON-RPC. A single extra byte on
stdout — a `console.log`, an unconfigured `pino` instance (whose default
destination is fd 1), a dependency printing a banner — corrupts the frame
stream. The host then fails to parse a response and reports a protocol error
that points nowhere near the real cause, which makes this class of bug
extremely expensive to diagnose.

The rules that keep the invariant:

- `src/logger.ts` passes `process.stderr` explicitly as pino's destination.
- No `console.*` call appears anywhere in `src/`.
- The startup line, the per-call line, and every error are written to stderr.
- `PINO_LOG_LEVEL` and `NODE_ENV=development` (for `pino-pretty`) tune
  verbosity without changing the destination.

## Compatibility Matrix

| Agent | Status | Config location | Guide |
| --- | --- | --- | --- |
| OpenCode v1 | UNVERIFIED | `opencode.json` (project) or `~/.config/opencode/opencode.json` (global) | [agents/opencode.md](./agents/opencode.md) |
| OpenCode v2 | VERIFIED | `opencode.json` (project) or `~/.config/opencode/opencode.json` (global) | [agents/opencode.md](./agents/opencode.md) |
| Codex | UNVERIFIED | `~/.codex/config.toml` (unconfirmed) | [agents/codex.md](./agents/codex.md) |
| Claude Code | VERIFIED | `.mcp.json` (project) or `~/.claude.json` (local) | [agents/claude-code.md](./agents/claude-code.md) |
| Hermes Agent | PARTIALLY VERIFIED | `~/.hermes/config.yaml` | [agents/hermes.md](./agents/hermes.md) |

`VERIFIED` means the config was written or read back by that agent's own CLI and
the server was observed to connect, on the version named in the guide. The full
index is in [agents/README.md](./agents/README.md) and the copy-paste configs are
in [`examples/agents/`](../examples/agents/).

Two config details were found by observation rather than documentation, and both
corrected what this project previously claimed: OpenCode v2 nests the entry at
`mcp.servers.<name>` rather than `mcp.<name>`, and Hermes Agent uses
`--command ... --args ...` with a YAML config rather than a `--` style flag.

## Anti-Fabrication

A real agent in Phase 4 reported a `pre_action_check` verdict the server never
sent: the server said `deny`, the agent said `allow`. The gate worked; the report
of it did not. This section is the mechanism that makes the report checkable.

```
Agent ──pre_action_check──▶ Server
  ◀── decision + nonce ────┘
  │
  ├── verify_decision(nonce, decision) ──▶ Server
  │                                        ├── valid?  ──▶ audit: verify_decision
  │                                        └── invalid ──▶ audit: fabrication_suspected
  │
  └── (optional) make the change
```

The server issues a `nonce` with every verdict: 16 CSPRNG bytes, base64url, 22
characters. It is single use, so one real decision cannot be laundered into many
claims. The agent presents the nonce together with the decision it intends to
report, and the server compares.

### Where the pieces sit

```
             ┌──────────────── src/tools/ ────────────────┐
  agent ────▶│ pre_action_check                           │
             │   rate limit ─▶ issue nonce ─▶ analyze()   │
             │ verify_decision                            │
             └───────┬──────────────┬──────────────┬──────┘
                     │              │              │
        ┌────────────▼───┐  ┌───────▼────────┐  ┌──▼──────────────┐
        │ ratelimit/     │  │ store/         │  │ audit/          │
        │ sliding-window │  │ nonce-store    │  │ audit-log       │
        │ (window, max)  │  │ (LRU, 1h... 5m)│  │ (JSONL, 10MB)   │
        └────────────────┘  └────────────────┘  └─────────────────┘
                     ▲              ▲
                     └────── src/config/loader.ts ───┘
                              (mode, denylist, limits)
```

- **`src/config/loader.ts`** resolves configuration once at startup and is the only
  thing that reads the filesystem for settings. A bad file stops the server.
- **`src/ratelimit/sliding-window.ts`** sits in front of everything, so a runaway
  loop cannot make the engine spawn processes.
- **`src/store/nonce-store.ts`** holds issued nonces, bounded and self-sweeping
  on issue rather than on a timer.
- **`src/audit/audit-log.ts`** is the ground truth for a dispute. Off by default;
  `taskDescription` is stored as a truncated SHA-256, never as text.

### The honest limit

Enforced mode refuses to produce a new verdict while a previous one is
unacknowledged. **It cannot block a file edit.** MCP has no channel to the
filesystem the agent writes to, so a `deny` is only binding on an agent that
treats it as binding. See [ADR 0006](./decisions/0006-anti-fabrication-strategy.md).

## Distribution

GATEKEEPER MCP ships as a single npm package. Three install paths exist, and
they exist because the three use cases are genuinely different rather than as
variations on a theme.

| Path | Command | Use when |
| --- | --- | --- |
| npx, no install | `opencode mcp add gatekeeper -- npx -y gatekeeper-mcp` | Trying it out, or a machine you do not want to modify |
| Global install | `curl -fsSL .../install.sh \| bash` | Normal use, and anything automated |
| Clone and build | `git clone ... && npm ci && npm run build` | Working on the project, or a locked-down machine |

**The package is the build output, not the source.** `files` allows `dist`,
`README.md`, `LICENSE`, and `SKILL.md` only, so a consumer gets compiled
JavaScript and the agent-facing skill, and nothing that could be mistaken for a
supported configuration surface. `npm pack --dry-run` is asserted against that
allowlist in CI, so a file added to the repository by accident cannot ship.

**Why npx is not the only story.** The first start under npx downloads the
package, which can be slow enough to trip an agent's MCP start-up timeout. A
global install pays that cost once, at install time. That is the whole reason the
installer exists rather than a README line.

**Why cloning is still documented.** Until the package reaches the registry, the
clone path is the only one that works. Afterwards it remains the correct path for
anyone changing the server, and the one the per-agent guides use, because those
snippets need an absolute path to a build that exists.

**The tarball is built from source, not from a stale `dist/`.** `dist/` is
gitignored, and `npm pack` does not run `prepublishOnly`, so a plain `npm pack` in
a fresh checkout would otherwise produce a package containing no server at all —
the `files` allowlist would silently include nothing. A `prepack` script that runs
the build closes that, which is what makes `npm pack` reproducible from any clean
checkout and not only from a working tree someone happened to build in.

**Publishing** is described in
[ADR 0003](./decisions/0003-npm-publish-strategy.md). In short: GitHub Actions on a
`v<major>.<minor>.<patch>` tag whose numbers must equal `package.json`, the full
check suite on Linux and macOS, then `npm publish --provenance` on Linux.
Manual publishing is prohibited by policy, so the published artefact is always a
clean checkout of a tagged commit.

## Future Work

Roadmap, deliverables, and exit criteria for every phase are in
[phases.md](./phases.md). In short: Phase 2 replaced the stubbed engine with real
reproduction and state inspection, Phase 3 produced per-agent guides and a
verification script, Phase 4 distributes the server, and Phase 5 adds rate
limiting, file-pattern policies, a `.gatekeeperrc.json` config file, and a
telemetry-free audit log.
