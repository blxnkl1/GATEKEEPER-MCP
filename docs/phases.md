# Phases

GATEKEEPER MCP is delivered in five phases. Each phase below states its goal,
its deliverables, and the exit criteria that must hold before work on the next
phase begins. Phases are sequential by design: the MVP proves the protocol
contract, Phase 2 makes the verdicts trustworthy, and only then is it worth
polishing distribution and hardening.

---

## Phase 1 — MVP (current)

**Goal.** Prove the end-to-end contract: an agent can call a `pre_action_check`
tool over STDIO, and the server can tell it *not to edit*. The engine is
stubbed on purpose, so the interesting work here is the protocol surface, the
validation layer, and the fail-closed default.

**Deliverables**

- `pre_action_check` tool registered on an `McpServer` named `gatekeeper-mcp`,
  exposed over `StdioServerTransport`.
- Zod input and output schemas: `taskDescription`, `proposedChange`, optional
  `affectedFiles`, optional `evidenceOfProblem`; output `decision`, `reason`,
  `nextSteps`.
- A three-stage engine pipeline in `src/engine/`: reproduction checker, state
  inspector, decision engine, orchestrated by `analyzer.ts`.
- Stage short-circuiting: a blocking verdict from stage 1 or 2 returns without
  reaching stage 3.
- Fail-closed policy: with no way to verify a change, the decision engine
  returns `request_info` rather than `allow`.
- A pino logger bound to `process.stderr`.
- Tests covering server construction, tool registration, and the deny path.
- `SKILL.md` defining the agent-facing contract.

**Acceptance Criteria**

- `npm run typecheck` passes under `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- `npm run lint` passes with Biome recommended rules.
- `npm test` passes.
- `analyze()` with no `evidenceOfProblem` returns `decision: 'deny'`.
- The server never returns `allow` in Phase 1.
- A real STDIO handshake against `node dist/index.js` returns a tool list
  containing `pre_action_check`.
- No `console.*` call exists in `src/`, and every byte on stdout is valid
  JSON-RPC.

### Exit Criteria

- [x] `pre_action_check` is registered and callable over STDIO.
- [x] Input and output are validated with zod at both boundaries.
- [x] Missing evidence produces `deny`; unverifiable evidence produces `request_info`.
- [x] `allow` is unreachable in Phase 1.
- [x] All logging goes to stderr; stdout carries only JSON-RPC.
- [x] Typecheck, lint, and tests pass.
- [x] `SKILL.md` states the agent's obligations for each decision.
- [ ] Seeded `git init` with a Conventional Commits history.

---

## Phase 2 — Real Engine (done)

**Goal.** Replace the stubs with real inspection, so that `allow` becomes a
meaningful and trustworthy verdict instead of something the server refuses to
issue. This is the phase that decides whether the project is actually useful.

> **Phase 2 is the first phase in which `decision: "allow"` becomes reachable.**
> Before it, the engine could only refuse. The bar for approval is deliberately
> high and is fixed by [ADR
> 0002](decisions/0002-phase-2-decision-policy.md): an executed reproduction
> matching the declared expectation, a verified clean working tree, and no green
> test suite contradicting the failure.

**Deliverables**

- **`reproduction.ts`** — run a user-provided reproduction command in a child
  process, capture its exit code and capped output, and time out cleanly. A
  non-zero exit under the default `expectFailure: true` is evidence of a problem;
  a zero exit is evidence against the change. A command that cannot be executed,
  or that dies on a signal, is never treated as a failure. Free text is never
  accepted as proof. Owns the `executeCommand` primitive described in
  [architecture.md](architecture.md#reproduction-safety-model).
- **`state.ts`** — run `git rev-parse --is-inside-work-tree` and
  `git status --porcelain` to classify the working tree as clean, dirty, or
  unknown; detect the package manager from the lockfile; read `scripts.test`
  from `package.json`; and run the suite when `runTests` is true. Only the exit
  code is interpreted, never scraped test output.
- **`decision.ts`** — the full ordered policy, with `allow` reachable only
  through the reproduced-plus-clean path. Every verdict is logged at info level.
- Dependency injection for every side effect via `Deps`, so the engine is fully
  testable without spawning a process or running real git.
- A timeout clamped to 1000-300000 ms and a 16 KB cap per output stream on
  every command the engine executes, so a hanging or flooding child cannot wedge
  the agent session.
- Tests for each stage in isolation, plus pipeline tests for each of the three
  decisions, including an exhaustive reachability check on `allow`.

**Acceptance Criteria**

- A real failing command yields `allow`; a real passing command yields `deny`.
- A hanging command is killed at the timeout and never blocks the session.
- Command output is truncated to the configured size limit.
- The engine never writes to stdout, including when a child process is spawned
  with inherited stdio.
- Every decision remains fully explained by `reason` and `nextSteps`, and
  returns the `evidence` and `state` that produced it.
- `allow` is unreachable unless the failure was reproduced **and** the tree is
  verified clean **and** no requested suite passed.

### Exit Criteria

- [x] `reproduction.ts` executes a user command and reports its exit code.
- [x] `state.ts` reports the working tree and the state of the test suite.
- [x] `decide.ts` implements the full allow/deny/request_info policy.
- [x] `allow` is reachable and covered by a test with a real command.
- [x] Every spawned command has a timeout and an output cap.
- [x] No path in the engine can write to stdout.
- [x] Stage-level and pipeline-level tests all pass (81 tests).
- [x] No new runtime dependencies; Node built-ins only.
- [x] [ADR 0002](decisions/0002-phase-2-decision-policy.md) records the decision
      to make `allow` reachable and the conditions that gate it.

### Phase 2 — Known Limitations

These are accepted for Phase 2 and are **not** bugs to be worked around. They
are listed so nobody mistakes them for guarantees.

- **Test runner detection is Node-ecosystem only.** A `scripts.test` entry in
  `package.json` plus a lockfile decides the runner: `pnpm-lock.yaml` to pnpm,
  `yarn.lock` to yarn, `bun.lockb` or `bun.lock` to bun, otherwise npm. A Python,
  Go, Rust, Ruby, or Java project has no `package.json`, so `tests` is reported
  as `unknown` and the suite never runs. Multi-language monorepos are affected
  the same way. Supporting other ecosystems means detecting a runner per project
  layout, which is not Phase 2 work.
- **No config file.** The test-suite timeout is hard-coded at 120 s and the
  reproduction timeout defaults to 30 s, clamped to 1000-300000 ms. Neither is
  configurable. `.gatekeeperrc.json` arrives in Phase 5.
- **No allowlist or denylist of commands.** Any executable on `PATH` can be run
  as a reproduction. There is no restriction to a known set of test runners, and
  no denylist of destructive commands. This is the single largest gap in the
  safety model and is Phase 5 work. The current controls (no shell, confined
  working directory, closed stdin, output cap, hard timeout) reduce the blast
  radius but do not constitute a sandbox; see
  [architecture.md](architecture.md#reproduction-safety-model).
- **Working directory confinement is lexical, not resolved.** A `cwd` inside the
  repository that is a symlink pointing outside it passes the check. Resolving
  symlinks with `realpath` would close this and is a small, self-contained fix.
- **Only the exit code is interpreted.** A reproduction is judged purely by how it
  exits, so a command that fails for an unrelated reason (a missing fixture, a
  typo in a path) looks exactly like a genuine bug. Agents should prefer a
  specific test command over a broad build or lint command for this reason.
- **Test output is never parsed.** Correct across runners, but it means a suite
  that passes while covering nothing is reported as `pass`.
- **`affectedFiles` is not used by the engine.** The Phase 2 plan proposed
  inspecting those files for behaviour that already implements the task. That
  check was dropped: it requires deciding whether code "already implements"
  something, which is a judgement call that does not belong in a gatekeeper.
  The input is still accepted so existing callers keep working.
- **The test suite is skipped outside a git repository.** A non-repository
  directory reports `tests: 'skipped'` even when `runTests: true`, because the
  repository check short-circuits first. Running tests in an unpacked tarball
  would be reasonable; it is simply not implemented.
- **Signal deaths are unverifiable, not failures.** A reproduction killed by
  anything other than our own timeout reports no exit code and is treated as
  `unverifiable`, so a crash-loop cannot be mistaken for a reproduced bug.
- **One timeout test takes about one second.** The minimum clamp of 1000 ms is
  real, so the timeout path is tested against a real clock rather than a fake
  timer. This is a deliberate trade for a test that cannot lie about timing.

---

## Phase 3 — Agent Integration

**Goal.** Make the server work reliably in every supported agent, with exact
configuration that is tested against each agent rather than guessed.

**Deliverables**

- Verified wiring for **OpenCode** v1 and v2, **Codex**, **Claude Code**, and
  **Hermes Agent**, covering both local config files and any supported CLI
  command.
- Exact, copy-pasteable config snippets in the README for each agent.
- A short section per agent covering session start-up, tool visibility, and how
  to confirm the gate is actually being called.
- A note on which agents can *enforce* the gate versus merely *advisable* of
  it, and what to do when a host exposes tools without permission controls.
- The compatibility matrix in `docs/architecture.md` updated with the verified
  paths and formats.

**Acceptance Criteria**

- Each agent lists `pre_action_check` after following the documented steps.
- A call from each agent returns a verdict and reaches the model.
- Instructions in the tool description are sufficient to change agent
  behaviour without additional prompting.
- Documented paths and key names match the agents' current released versions.

### Exit Criteria

- [ ] All four agents verified against a real session.
- [ ] README snippets copy-paste without edits.
- [ ] Compatibility matrix updated with verified, current paths.
- [ ] Enforce-versus-advise distinction documented per agent.
- [ ] Every version-sensitive snippet records the version it was tested on.

---

## Phase 4 — Distribution

**Goal.** Remove every reason for a user to build from source.

**Deliverables**

- Publish to npm as `gatekeeper-mcp`, with correct `bin` wiring and a
  `prepublishOnly` build step.
- Verified `npx gatekeeper-mcp` invocation, including on a clean machine with
  no global install.
- A `curl | bash` installer that clones or downloads a pinned release, builds
  it, and prints agent-specific next steps.
- A GitHub Actions release workflow: typecheck, lint, test, build, publish, and
  release on a tag.
- Versioned documentation and a changelog generated from Conventional Commits.

**Acceptance Criteria**

- `npx gatekeeper-mcp` starts on a clean machine and answers a STDIO handshake.
- The `curl | bash` installer succeeds on macOS and Linux.
- Publishing is fully automated from a tagged commit.
- A failed check blocks the release.

### Exit Criteria

- [ ] Package published to npm and installable via `npx`.
- [ ] `curl | bash` installer tested on macOS and Linux.
- [ ] Release workflow runs all checks and publishes on a tag.
- [ ] Changelog generated from Conventional Commits.
- [ ] README install path no longer requires `git clone`.

---

## Phase 5 — Hardening

**Goal.** Make the gatekeeper safe to leave switched on permanently.

**Deliverables**

- **Rate limits** per client session, so a loop of speculative edits cannot
  hammer the engine.
- **Allowlist and denylist** of file patterns, so generated files, lockfiles,
  and vendored code are gated differently from source.
- **`.gatekeeperrc.json`** — a project-level config for thresholds, timeouts,
  file patterns, and policy overrides. Validated with zod, with a documented
  default for every field.
- **Audit log** — an append-only local record of every decision, for
  explaining a denial after the fact. Strictly local: no telemetry, no remote
  sink, and a documented retention policy.
- A documented incident-response story for a false `deny`: what the user can
  inspect, and how to override the gate for a single change.

**Acceptance Criteria**

- Rate limits are enforced and configurable, and never silently disable the
  gate.
- File-pattern rules are applied before any command is executed.
- `.gatekeeperrc.json` is optional; the server behaves identically without it,
  and reports clearly on an invalid file instead of failing open.
- The audit log is written only to disk under the user's control and contains
  no model prompts, credentials, or file contents.
- The server still performs no network egress, verified in CI.

### Exit Criteria

- [ ] Rate limiting implemented and configurable.
- [ ] Allowlist and denylist applied, with tests for both.
- [ ] `.gatekeeperrc.json` supported, optional, and schema-validated.
- [ ] Local audit log implemented with a documented retention policy.
- [ ] Network-egress check added to CI.
- [ ] ADR written for the config file format and the audit log's data boundary.
