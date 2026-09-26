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

## Phase 2: executable evidence

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
  expectFailure?: boolean; // default true: non-zero exit means reproduced
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
4. `expectFailure: true` (the default) means "this should fail today". Set it to
   `false` only for a check that is expected to succeed today and that the change
   would break.
5. A `deny` with `evidence.state: "not_reproduced"` means the command **passed**,
   so the code is likely already correct. Do not retry with a different command
   just to get an `allow`; report that the task appears already satisfied.
6. `request_info` with a `dirty` working tree means commit or stash first, then
   re-run. Uncommitted changes make a failure untrustworthy.

An `allow` is only issued when the failure was reproduced, the working tree is
clean, and no green test suite contradicts the failure. Committing unrelated
work before calling the tool is what makes the difference between `allow` and
`request_info`.

## Anti-patterns this skill prevents
1. Refactoring code that is already correct.
2. "Improving" code without a failing test or reproduction.
3. Renaming, reformatting, or restructuring as a side effect.
4. Fixing bugs that cannot be reproduced.
5. Adding abstractions "for the future".

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
Register this MCP server in the agent's config. Examples:
- **OpenCode**: add to `opencode.json` → `mcp.servers.gatekeeper.type = "local"`, `command = ["node", "<REPO>/dist/index.js"]`.
- **Codex**: `~/.codex/config.toml` → `[mcp_servers.gatekeeper]`, `command = "node"`, `args = ["<REPO>/dist/index.js"]`.
- **Claude Code**: `claude mcp add gatekeeper -- node <REPO>/dist/index.js`.
- **Hermes Agent**: `hermes mcp add gatekeeper --command node --args <REPO>/dist/index.js`.

### Where to find per-agent setup
- `docs/agents/` — full guides, one per agent.
- `examples/agents/` — copy-paste configs.
- `scripts/verify-agent.sh <agent-cli>` — checks that `pre_action_check` is loaded.

## Guardrails for the agent working ON this project
- Do NOT implement Phase 2+ features while in Phase 1. Stubs stay stubs until their phase.
- Do NOT introduce networking, telemetry, or remote calls. This project is LOCAL-ONLY.
- Do NOT touch `stdout` in any code path. If you need to debug, use `logger.debug(...)`.
- Do NOT add a config loader, CLI framework, or ORM. Keep it minimal.
- If unsure, call `pre_action_check` on your own proposed change.
