---
name: gatekeeper-mcp
description: A local MCP server that prevents Action Bias in coding agents by gating code-changing actions behind an evidence check. Use this skill whenever you work on GATEKEEPER MCP, or whenever you (the agent) are about to modify code and want to verify the change is justified.
license: MIT
---

# GATEKEEPER MCP — Agent Skill

## When to use this skill
- You are developing, debugging, or extending the GATEKEEPER MCP project.
- You are an agent deciding whether to modify code in ANY repository, and you want a rule-based second opinion before editing.

## Core rule
> Before modifying ANY file, the agent MUST call the `pre_action_check` tool with:
> - `taskDescription`
> - `proposedChange`
> - `affectedFiles` (optional)
> - `evidenceOfProblem` (optional but strongly recommended)
> - `reproduction` (optional, but the only way to ever get `allow`)

If the tool returns `decision: "deny"`, the agent MUST NOT modify files. Instead, reply with:
> "No change needed — the current code already satisfies the task."

If `decision: "request_info"`, the agent MUST ask the user for the missing evidence (reproduction steps, failing test, etc.) BEFORE editing.

If `decision: "allow"`, the agent may proceed.

## Executable evidence

Free-text `evidenceOfProblem` is **never** sufficient. A paragraph describing a
stack trace is as easy to fabricate as a change is to justify, and it cannot be
checked. The server returns `request_info` for free-text evidence alone, every
time.

To obtain an `allow`, the agent MUST supply an executable `reproduction`:

```
reproduction: {
  command: string;         // bare executable, e.g. "npm", "pytest", "node"
  args?: string[];         // everything else goes here
  cwd?: string;            // must be inside the repository root
  timeoutMs?: number;      // default 30000, range 1000-300000
  expectFailure?: boolean; // descriptive only; never affects the verdict
}
```

Example:

```json
{
  "taskDescription": "Uploads hang when the network is slow",
  "proposedChange": "Add a bounded retry around the upload call",
  "reproduction": { "command": "npm", "args": ["test", "--", "upload.test.ts"] }
}
```

Rules the agent MUST follow:

1. `command` is a **bare executable**. `command: "npm test"` is rejected. Split it
   into `command: "npm"` and `args: ["test"]`. Never use `&&`, `|`, `;`, `$()`,
   or any other shell syntax; the command is not run through a shell.
2. Prefer a **narrow, failing test** over a broad build, lint, or whole-suite
   command. Only the exit code is read, so a command that fails for an unrelated
   reason looks exactly like a genuine bug.
3. The command must be **reproducible right now** and must pass once the bug is
   fixed. If it fails forever, or passes now, it is not evidence.
4. `expectFailure` is **descriptive only**. It records whether you expected the
   command to fail today, and it cannot change the verdict. Only a non-zero exit
   is ever treated as failure evidence: a command that exits `0` is a `deny`
   whatever you pass here. Do not try to obtain an `allow` by flipping it.
5. A `deny` with `evidence.state: "not_reproduced"` means the command **exited
   zero**, so the code is likely already correct. Do not retry with a different
   command just to get an `allow`; report that the task appears already
   satisfied.
6. `request_info` with a `dirty` working tree means commit or stash first, then
   re-run. Uncommitted changes make a failure untrustworthy.

An `allow` is only issued when **all four** of these hold:

1. the reproduction command ran and exited non-zero,
2. the git working tree is clean,
3. the server ran the project's own verification command,
4. that verification command also failed.

The first two are your claim. The last two are the part you do not control, and
they are why a command you chose cannot buy an approval on its own. In
particular `{"command":"false"}` will not be approved on a healthy project: the
server runs the project's tests, they pass, and the change is held back.

Two consequences worth knowing before you plan a fix:

- **A green suite means `request_info`, not `allow`.** If the project already
  passes its tests, the reported bug is not confirmed by them. The next step is to
  add a failing test that captures the bug, then re-run the check. Do not try to
  talk your way past this; the server has already looked.
- **A project with no verification command can never be approved.** The server
  reports `tests: "unknown"` and denies. If that is your project, say so and ask
  the user to configure `testCommand`.

Committing unrelated work before calling the tool is what makes the difference
between `allow` and `request_info`.

## Anti-patterns this skill prevents
1. Refactoring code that is already correct.
2. "Improving" code without a failing test or reproduction.
3. Renaming, reformatting, or restructuring as a side effect.
4. Fixing bugs that cannot be reproduced.
5. Adding abstractions "for the future".

## Reporting the server's decision

Every `pre_action_check` response contains a `nonce`. If you (the agent) report
a decision to the user, you MUST first call `verify_decision` with that nonce
and the decision you intend to report. If verification fails, do not report a
decision; report the verification failure instead. Fabricating a decision is
worse than reporting no decision.

## Workflow the agent must follow
1. Read the task.
2. Form a hypothesis about the change.
3. **Call `pre_action_check` BEFORE editing.**
4. If allowed → make the minimal edit that satisfies the evidence.
5. If denied → report back, do NOT edit.
6. If info requested → ask the user, then re-run the check.

## Project conventions
- TypeScript strict, ESM (`NodeNext`).
- STDIO transport only. **Never** write to stdout — only stderr via the pino logger.
- Every tool input/output is validated with zod.
- Tests live next to `tests/`, one file per source module.
- Biome for lint + format. Run `npm run lint` before finishing a task.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Never add a dependency without checking it's needed and writing a one-line justification in the PR description.
- Never modify files outside the `src/`, `tests/`, `docs/`, `scripts/` folders unless explicitly asked.

## How to invoke (for agents)

**Primary: the published package.** Register the npx form and let the agent fetch
it:

- **OpenCode**: `opencode mcp add gatekeeper -- npx -y gatekeeper-mcp`
- **Codex**: UNVERIFIED. See `docs/agents/codex.md`.
- **Claude Code**: `claude mcp add gatekeeper -- npx -y gatekeeper-mcp`
- **Hermes Agent**: `hermes mcp add gatekeeper --command npx --args -y gatekeeper-mcp`
  (Hermes connects first, lists the tools it finds, then asks which to enable.
  Answer `Y` to enable `pre_action_check`.)

**Development path: a local build.** When working on the project itself:

```bash
git clone https://github.com/blxnkl1/GATEKEEPER-MCP.git
cd GATEKEEPER-MCP
npm ci && npm run build
```

- **OpenCode**: `opencode mcp add gatekeeper -- node <REPO>/dist/index.js`
- **Codex**: `[mcp_servers.gatekeeper]`, `command = "node"`, `args = ["<REPO>/dist/index.js"]`
- **Claude Code**: `claude mcp add gatekeeper -- node <REPO>/dist/index.js`
- **Hermes Agent**: `hermes mcp add gatekeeper --command node --args <REPO>/dist/index.js`

The path must be absolute: MCP servers start with an unspecified working
directory, so a relative path will not resolve.

### Where to find per-agent setup
- `docs/agents/` — full guides, one per agent.
- `examples/agents/` — copy-paste configs.
- `scripts/verify-agent.sh <agent-cli>` — checks that `pre_action_check` is loaded.

### Never report a verdict you did not receive

`scripts/e2e/` has observed an agent report a `pre_action_check` result the server
never sent, including a fabricated `allow` where the real answer was `deny`. If a
tool call returns nothing, or the result looks inconsistent with the arguments
you passed, say exactly that and stop. Do not reconstruct, guess, or paraphrase
a verdict. A wrong `allow` is the one outcome this tool exists to prevent.

## Guardrails for the agent working ON this project
- Do NOT weaken the ALLOW invariant. `allow` requires a non-zero exit, a clean
  tree, and a server-observed failing verification command. If a change seems to
  need one of those relaxed, stop and say so.
- Do NOT reintroduce `runTests`, or any other agent-controlled flag that decides
  whether the gate cross-checks a claim. That flag is why `{"command":"false"}`
  used to be approved.
- Do NOT add a process-execution API. `executeCommand` is the only one; a second
  path bypasses its shell, timeout, and output guards.
- Do NOT introduce networking, telemetry, or remote calls in the server. This
  project is LOCAL-ONLY. (Reproduction commands are a separate matter: they run
  under the configured execution policy, which is documented, not sandboxed.)
- Do NOT touch `stdout` in any code path. If you need to debug, use `logger.debug(...)`.
- Do NOT add a config loader, CLI framework, or ORM. Keep it minimal.
- Do NOT weaken a test to make it pass. If a security test fails, the security
  property is broken; fix the code, and if the property is genuinely wrong,
  change the test and the ADR together so the change is reviewable.
- If unsure, call `pre_action_check` on your own proposed change.
