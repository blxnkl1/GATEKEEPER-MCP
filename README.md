# GATEKEEPER MCP

A local [Model Context Protocol](https://modelcontextprotocol.io) server that
sits between a coding agent and any code-modifying action. Before the agent
edits a file, it calls `pre_action_check`; if the change is not justified by
evidence, or the task is already solved, the server tells the agent to stop and
report back instead of writing code.

## What is GATEKEEPER MCP?

GATEKEEPER MCP is a single-binary MCP server that gates file modifications
behind an evidence check. It exposes one tool, `pre_action_check`, which returns
one of three decisions — `allow`, `deny`, or `request_info` — together with a
reason and concrete next steps. The agent is expected to call it before every
edit and to treat a `deny` as final. It runs entirely on your machine over
STDIO, performs no network calls, and sends no telemetry.

## Why?

LLM coding agents suffer from **Action Bias**: the tendency to change code when
no change is warranted. A plausible-looking diff gets produced whether or not a
bug existed, whether or not the code was already correct, and whether or not the
agent can reproduce the problem it claims to be fixing. The result is churn that
looks like progress and quietly breaks working software.

Estimates of the rate at which coding agents propose unnecessary edits commonly
land in the **35–65% range**. Treat that as an order-of-magnitude figure rather
than a precise measurement: it varies wildly by task, model, and how "unnecessary"
is defined, and the primary sources are informal. It is included here to
establish that the problem is large, not to be cited as a hard number.

The intervention is deliberately blunt. Do not make an edit until you can show
the problem it fixes.

## Install

Requires **Node.js >= 20** and **npm**.

```bash
git clone https://github.com/<YOUR NAME>/gatekeeper-mcp.git
cd gatekeeper-mcp
bash scripts/install.sh
```

The installer checks your Node version, runs `npm ci`, builds to `dist/`, and
prints the configuration for your agent. Manual equivalent:

```bash
npm install
npm run build
```

## Quick start with any agent

The server is not published to npm yet (that is Phase 4), so point your agent at
the built entrypoint. Use `<PATH_TO_REPO>` for the **absolute** path to this repo:
MCP servers start with an unspecified working directory, so a relative path will
not resolve.

**OpenCode** — `opencode.json`:

```bash
opencode mcp add gatekeeper -- node <PATH_TO_REPO>/dist/index.js
```

```json
{
  "mcp": {
    "servers": {
      "gatekeeper": {
        "type": "local",
        "command": ["node", "<PATH_TO_REPO>/dist/index.js"]
      }
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.gatekeeper]
command = "node"
args = ["<PATH_TO_REPO>/dist/index.js"]
```

**Claude Code**:

```bash
claude mcp add gatekeeper -- node <PATH_TO_REPO>/dist/index.js
```

**Hermes Agent** — `~/.hermes/config.yaml`. This command is interactive: it
connects, lists the tools it finds, and asks which to enable. Answer `Y`.

```bash
hermes mcp add gatekeeper --command node --args <PATH_TO_REPO>/dist/index.js
```

Once published to npm, every command above works with `npx gatekeeper-mcp`
instead.

### Compatibility matrix

| Agent | Status | Config path | Guide |
| --- | --- | --- | --- |
| OpenCode v1 | UNVERIFIED | `opencode.json` | [docs/agents/opencode.md](./docs/agents/opencode.md) |
| OpenCode v2 | VERIFIED | `opencode.json` | [docs/agents/opencode.md](./docs/agents/opencode.md) |
| Codex | UNVERIFIED | `~/.codex/config.toml` (unconfirmed) | [docs/agents/codex.md](./docs/agents/codex.md) |
| Claude Code | VERIFIED | `~/.claude.json` / `.mcp.json` | [docs/agents/claude-code.md](./docs/agents/claude-code.md) |
| Hermes Agent | PARTIALLY VERIFIED | `~/.hermes/config.yaml` | [docs/agents/hermes.md](./docs/agents/hermes.md) |

Configs that are not yet fully verified are marked accordingly in each guide.

- Full guides, with troubleshooting and scope: [docs/agents/](./docs/agents/)
- Copy-paste configs: [examples/agents/](./examples/agents/)
- Check an install: `bash scripts/verify-agent.sh opencode`
- Manual checklist: [docs/agents/VERIFICATION.md](./docs/agents/VERIFICATION.md)

The snippets above are a starting point. Prefer each agent's `mcp add` command
over hand-editing a file: the CLI writes whatever the installed version actually
expects, which is the one thing that changes between major versions.

## Tools

### `pre_action_check`

Gatekeeper check. Call this BEFORE modifying any code. It verifies whether the
change is justified by evidence and whether the task is already solved. If not
justified, the agent MUST NOT edit files.

**Input**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `taskDescription` | `string` | yes | What the agent is trying to accomplish. |
| `proposedChange` | `string` | yes | The diff, or a natural-language description of the change. |
| `affectedFiles` | `string[]` | no | Files the agent intends to modify. |
| `evidenceOfProblem` | `string` | no | Reproduction steps, a failing test, or an error log. |
| `reproduction` | `object` | no | An executable command that reproduces the problem. |
| `runTests` | `boolean` | no | Run the project test suite as extra evidence. Default `false`. |

`reproduction` is the field that matters. Free text is never accepted as proof,
so `evidenceOfProblem` on its own can only ever produce `request_info`.

| `reproduction` field | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | — | Bare executable, e.g. `"npm"`, `"pytest"`, `"node"`. |
| `args` | `string[]` | `[]` | Arguments. **Never** put arguments in `command`. |
| `cwd` | `string` | repo root | Must resolve inside the repository root. |
| `timeoutMs` | `number` | `30000` | Kill after this long. Range 1000-300000. |
| `expectFailure` | `boolean` | `true` | `true`: non-zero exit means reproduced. `false`: invert it. |

The command is spawned directly, never through a shell. `command: "npm test"`
is rejected, because accepting a string like that would mean handing it to a
shell. Split it into `command: "npm"` and `args: ["test"]`.

**Output**

| Field | Type | Description |
| --- | --- | --- |
| `decision` | `"allow" \| "deny" \| "request_info"` | The verdict. |
| `reason` | `string` | Why the verdict was reached. |
| `nextSteps` | `string[]` | Ordered instructions the agent should follow. |
| `evidence` | `object` | What the reproduction stage found. |
| `state` | `object` | What the state inspection stage found. |

| `evidence` field | Type | Description |
| --- | --- | --- |
| `state` | `"reproduced" \| "not_reproduced" \| "unverifiable" \| "timeout"` | Outcome of the reproduction. |
| `detail` | `string` | Human-readable explanation. |
| `exitCode` | `number` | Present only when a command actually ran. |
| `durationMs` | `number` | How long the command took. |

| `state` field | Type | Description |
| --- | --- | --- |
| `workingTree` | `"clean" \| "dirty" \| "unknown"` | Git working tree status. |
| `tests` | `"pass" \| "fail" \| "skipped" \| "unknown"` | Result of the test suite. |
| `detail` | `string` | Human-readable explanation. |

**Decisions**

- `allow` — justified, proceed with the edit. Reachable **only** when the
  reproduction was executed and failed as declared, the working tree is clean,
  and no green test suite contradicts the failure.
- `deny` — not justified, do not touch any file. The agent should reply
  "No change needed — the current code already satisfies the task."
- `request_info` — evidence is missing, ask the user before editing.

### Reproduction command

A full call that can reach `allow`, for a bug where a test times out:

```json
{
  "taskDescription": "Uploads hang when the network is slow",
  "proposedChange": "Add a bounded retry around the upload call in src/upload.ts",
  "affectedFiles": ["src/upload.ts"],
  "reproduction": {
    "command": "npm",
    "args": ["test", "--", "upload.test.ts"],
    "timeoutMs": 60000
  },
  "runTests": false
}
```

The server runs `npm test -- upload.test.ts`, reads the exit code, and returns:

```json
{
  "decision": "allow",
  "reason": "Failure reproduced under a clean working tree. The change is justified.",
  "nextSteps": [
    "Make the minimal change that makes the reproduction pass.",
    "Do not refactor unrelated code."
  ],
  "evidence": {
    "state": "reproduced",
    "detail": "Reproduction succeeded: \"npm\" exited 1 in 843ms. Output: ...",
    "exitCode": 1,
    "durationMs": 843
  },
  "state": {
    "workingTree": "clean",
    "tests": "skipped",
    "detail": "The git working tree is clean."
  }
}
```

Set `expectFailure: false` for a check that is expected to pass today, such as an
assertion the change would break. A zero exit then means `reproduced`, in the
sense that the expected outcome was observed.

Change the same call to a command that exits `0` and the verdict flips to
`deny`: the reproduction succeeded, so the code may already be correct. That
asymmetry is the point.

## Development

```bash
npm run dev        # watch mode via tsx
npm test           # vitest, single run
npm run test:watch # vitest, watch mode
npm run typecheck  # tsc --noEmit
npm run lint       # biome check
npm run format     # biome format --write
npm run build      # compile to dist/
```

**Project layout**

```
src/
  index.ts                  entrypoint: stdio transport
  server.ts                 McpServer factory and tool registration
  logger.ts                 pino, bound to stderr
  tools/pre_action_check.ts the one tool
  engine/                   analyzer + reproduction / state / decision stages
  schemas/                  zod input and output schemas
  types/                    domain types
```

`stdout` is reserved for the JSON-RPC frame stream. All logging goes to stderr.
`SKILL.md` is the agent-facing contract and is the file to read if you are
building an agent that must respect the gate.

**Architecture:** [docs/architecture.md](./docs/architecture.md) ·
**Roadmap:** [docs/phases.md](./docs/phases.md) ·
**Decisions:** [docs/decisions/](./docs/decisions/)

## License

MIT — see [LICENSE](./LICENSE).
