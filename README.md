# GATEKEEPER MCP

**Stops coding agents from making changes they cannot justify.**

[![CI](https://github.com/blxnkl1/GATEKEEPER-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/blxnkl1/GATEKEEPER-MCP/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/gatekeeper-mcp.svg)](https://www.npmjs.com/package/gatekeeper-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local [Model Context Protocol](https://modelcontextprotocol.io) server that sits
between a coding agent and any code-modifying action. Before the agent edits a
file, it calls `pre_action_check`; if the change is not justified by evidence, or
the task is already solved, the server tells the agent to stop and report back
instead of writing code. Local-only: the server itself makes no network calls and
sends no telemetry.

## Install

Requires **Node.js >= 20**.

> **The two paths below need the package on npm.** `v1.0.0` is tagged but not yet
> published, so `npx -y gatekeeper-mcp` and the installer currently return a 404.
> They are the intended day-to-day install, and they are verified against a
> locally packed tarball rather than the registry. Until publication, use the
> from-source path at the bottom of this section.

**Try it without installing.** Let your agent fetch and run the package:

```bash
opencode mcp add gatekeeper -- npx -y gatekeeper-mcp
```

**Install it globally.** The installer places the binary in `$HOME/.local` and
then prints the exact command for your agent:

```bash
curl -fsSL https://raw.githubusercontent.com/blxnkl1/GATEKEEPER-MCP/main/scripts/install.sh | bash
```

Options: `--version <tag>` to pin, `--prefix <dir>` to change the install prefix
(default `$HOME/.local`), `--dry-run` to see what it would do. To remove it:

```bash
curl -fsSL https://raw.githubusercontent.com/blxnkl1/GATEKEEPER-MCP/main/scripts/uninstall.sh | bash
```

**Work on the project, or install from source.** This works today, with no
registry access:

```bash
git clone https://github.com/blxnkl1/GATEKEEPER-MCP.git
cd GATEKEEPER-MCP
npm ci
npm run build
opencode mcp add gatekeeper -- node "$PWD/dist/index.js"
```

To put that local build on your `PATH` instead of pointing at a checkout:

```bash
npm install -g --prefix "$HOME/.local" .
"$HOME/.local/bin/gatekeeper-mcp"    # starts, logs to stderr, waits on stdio
```

## Compatibility matrix

| Agent | Status | Config path | Guide |
| --- | --- | --- | --- |
| OpenCode v1 | UNVERIFIED | `opencode.json` | [docs/agents/opencode.md](./docs/agents/opencode.md) |
| OpenCode v2 | VERIFIED | `opencode.json` | [docs/agents/opencode.md](./docs/agents/opencode.md) |
| Codex | UNVERIFIED | `~/.codex/config.toml` (unconfirmed) | [docs/agents/codex.md](./docs/agents/codex.md) |
| Claude Code | VERIFIED | `~/.claude.json` / `.mcp.json` | [docs/agents/claude-code.md](./docs/agents/claude-code.md) |
| Hermes Agent | PARTIALLY VERIFIED | `~/.hermes/config.yaml` | [docs/agents/hermes.md](./docs/agents/hermes.md) |

Configs that are not yet fully verified are marked accordingly in each guide.

## What is GATEKEEPER MCP?

GATEKEEPER MCP is a single-binary MCP server that gates file modifications
behind an evidence check. It exposes two tools: `pre_action_check`, which returns
one of three decisions — `allow`, `deny`, or `request_info` — together with a
reason and concrete next steps, and `verify_decision`, which checks that the
decision an agent is about to report is the one the server actually issued. The
agent is expected to call the first before every edit and to treat a `deny` as
final. It runs entirely on your machine over STDIO, and sends no telemetry.

`allow` is issued only when **all four** of these hold, every one observed by the
server rather than asserted by the agent:

1. the reproduction command was executed and **exited non-zero**;
2. the git working tree is verified **clean**;
3. the project's own **verification command was run**;
4. that verification command **also failed**.

The last two are the point. The agent chooses the reproduction, so a non-zero
exit on its own proves only that the agent's command failed — `{"command":"false"}`
is the cheapest way to produce one. Requiring the project's own tests to fail as
well is what makes the claim falsifiable by something the agent does not control.
A command that exits `0` can never reach `allow`, and neither can persuasive
prose. See [ADR 0007](docs/decisions/0007-verification-command-decides-allow.md).

**What `allow` does not mean.** It means *this project is verifiably failing, the
tree is clean, and you supplied a command that fails.* It does not mean the server
has confirmed that your specific command demonstrates your specific bug. That
distinction is the honest limit of the design and is documented rather than
papered over.

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

## Free and local, permanently

GATEKEEPER MCP runs entirely on your machine. **GATEKEEPER itself performs no
network egress** — it opens no socket, resolves no name, sends no telemetry, and
requires no API key or account. All runtime dependencies are free and
open-source. The project is MIT-licensed and will remain so. See
[ADR 0005](docs/decisions/0005-free-and-local-forever.md).

One qualification, because the broader claim would be false: the reproduction
command GATEKEEPER runs on the agent's behalf *can* open network connections, the
same way any command you run can. Network fetchers (`curl`, `wget`, `nc`, `ssh`)
are on the default denylist to discourage that, but a permitted interpreter such
as `node -e` can still reach the network. The guarantee is about the server, not
about the processes it is asked to start.

The only cost you may incur is from the LLM that your coding agent uses —
GATEKEEPER itself never calls an LLM.

## Quick start with any agent

Use `<PATH_TO_REPO>` for the **absolute** path to your checkout of this repo. MCP
servers start with an unspecified working directory, so a relative path will not
resolve. If you installed from npm you can use `npx -y gatekeeper-mcp` instead and
skip this section; see [Install](#install).

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

Every command above works with `npx -y gatekeeper-mcp` instead of a local path.

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

`reproduction` is the field that matters. Free text is never accepted as proof,
so `evidenceOfProblem` on its own can only ever produce `request_info`.

`runTests` was removed in v1.0.0. It used to let the agent decide whether the gate
cross-checked its claim, which combined with the agent also choosing the
reproduction command to make `allow` free. The verification command is now run by
the server whenever it can change the verdict. Agents still sending `runTests` are
unaffected: the field is ignored, not rejected.

| `reproduction` field | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | — | Bare executable, e.g. `"npm"`, `"pytest"`, `"node"`. |
| `args` | `string[]` | `[]` | Arguments. **Never** put arguments in `command`. |
| `cwd` | `string` | repo root | Must resolve inside the repository root. |
| `timeoutMs` | `number` | `30000` | Kill after this long. Range 1000-300000. |
| `expectFailure` | `boolean` | `true` | Descriptive only. Records whether you expected this command to fail today. It **cannot** change the verdict: only a non-zero exit is ever treated as failure evidence. |

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
  reproduction exited non-zero, the working tree is clean, and the project's own
  verification command was run and also failed. A command that exited `0` cannot
  produce it. A project with no discoverable verification command can never be
  approved; set `testCommand` (see [Configuration](#configuration)).
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
  }
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

`expectFailure` records what you expected; it never decides anything. Set it to
`false` when you are checking an assertion that is expected to pass today, such
as one your change would break — the detail string will then note the
expectation, so a reader can see the result contradicted it.

The verdict depends on the exit code alone. A command that exits `0` is a
`deny`: the reproduction succeeded, so the code may already be correct. A
command that exits non-zero is failure evidence even if you declared you
expected it to pass, because a failure really was observed. That asymmetry is
the point, and it is why a caller cannot pick a polarity that turns a successful
command into an approval.

# Trust and audit

Every `pre_action_check` reply carries a `nonce`, a random 22-character token.
Before reporting a decision, call `verify_decision` with that nonce and the
decision you intend to report; it answers whether the server actually issued
that decision. A mismatch is recorded locally as a suspected fabrication.

Two modes, set in `.gatekeeperrc.json`:

- **`advisory`** (default) — `verify_decision` is available and mismatches are
  recorded, but nothing requires the agent to call it.
- **`enforced`** — a new `pre_action_check` call is refused while a previous
  decision is unverified, with the reason "Previous decision not verified. Call
  verify_decision first."

**Enforcement is limited to sequence violations. MCP cannot block file edits.**
The server can refuse to produce a new verdict until the last one was
acknowledged; it cannot stop a write, because it has no channel to the filesystem
the agent edits. See [ADR 0006](./docs/decisions/0006-anti-fabrication-strategy.md).

**Audit log.** Set `auditLog.enabled` to record every decision, verification, and
suspected fabrication as one JSON line. It defaults to `~/.gatekeeper/audit.log`,
rotates at 10 MB keeping one generation, and stores `taskDescription` as a
truncated SHA-256 rather than as text. It is off unless you turn it on, and it
never leaves the machine.

**Configuration** is read from `$GATEKEEPER_CONFIG`, then `.gatekeeperrc.json` in
the working directory, then `~/.gatekeeperrc.json`. An invalid file stops the
server rather than silently reverting to defaults.

```json
{
  "mode": "advisory",
  "rateLimit": { "windowMs": 60000, "max": 20 },
  "denylist": {
    "commands": ["rm", "dd", "mkfs", "shutdown", "reboot", "halt"],
    "patterns": ["rm\\s+-rf\\s+/", "curl.*\\|.*sh"]
  },
  "auditLog": { "enabled": true, "path": "~/.gatekeeper/audit.log" },
  "nonceStore": { "maxSize": 1000, "ttlMs": 300000 },
  "testCommand": ["pytest", "-q"],
  "testTimeoutMs": 180000
}
```

`testCommand` is the project's verification command as an **argv array**, not a
string, so declaring it never introduces a shell. It is operator configuration and
never agent input: this is the command whose failure makes `allow` possible, so
the agent must not be able to choose it. When it is unset, the command is detected
from the lockfile and `package.json` `scripts.test` as before.

Set it if your project is not npm-based, or if you want a narrower command than
the whole suite. **A project with no discoverable verification command can never
be approved**, because the gate would have nothing to cross-check the agent's
claim against. `testTimeoutMs` bounds that command; the default is 120000 ms.

No configuration can switch the security invariant off. `mode`, `rateLimit`,
`denylist`, `nonceStore` and `auditLog` change pressure, observability and
resource bounds; none of them can turn a zero exit or an unverified project into
an `allow`.

**Rate limit.** 20 calls per 60 s by default, per session. Exceeding it returns
a `deny` rather than a tool error, because being throttled is a decision the gate
reached, not a failure.

**Command denylist.** Reproduction commands whose basename is listed, or whose
command line matches a listed pattern, are refused before anything is spawned. The
default list includes the shells and script hosts (`sh`, `bash`, `zsh`, `env`,
`python3`, `perl`, `ruby`, …) as well as destructive commands and network
fetchers, because `bash -c "…"` is a shell by another name.

The denylist is a refusal list, **not** a sandbox and not the control that protects
the invariant. `node` stays allowed because it is ordinary tooling, and `node -e`
is a whole interpreter in one argument. What makes `allow` unreachable for such a
command is that the project's own verification command must fail too — see
[Execution boundary](#execution-boundary) for the full list of what is and is not
constrained.

## Execution boundary

What this server does and does not constrain. The difference between a gate and a
sandbox is the difference between a useful tool and a false claim, so it is worth
being exact.

**Constrained**

- the shape of the command it spawns: one primitive, `shell: false`, a bare
  executable plus an argv array, stdin closed, output capped at 16 KB per stream,
  time bounded and `SIGKILL`ed on expiry;
- the working directory: resolved through `realpath` and required to be the
  repository root or beneath it, so `..`, absolute paths, and symlinks pointing
  outside are all refused;
- which commands are acceptable, via a denylist you can extend;
- what the verdict may claim: every term in the `allow` conjunction is
  server-observed.

**Not constrained**

- **What the child process does.** No seccomp, no namespace, no chroot, no
  resource limit beyond output length. A permitted command can read and write
  anything the user can.
- **Which files the child touches.** Only `cwd` is confined; `args` are passed
  through verbatim. "Confined to the repository root" describes the working
  directory, not filesystem access.
- **Network egress by the child.** The server itself opens no socket. A
  reproduction command can, which is why fetchers are denylisted — and why
  `node -e` still reaches the network.
- **Descendant processes.** `SIGKILL` goes to the direct child only, so a
  reproduction that daemonises can outlive the call.
- **Whether a failure matches the bug you described.** See
  [ADR 0007](docs/decisions/0007-verification-command-decides-allow.md).
- **Whether you edit a file after a `deny`.** MCP is request/response over stdio;
  the server has no channel to the filesystem you write through. Enforcement is
  limited to sequence violations. Making a `deny` binding requires gating the
  write tool on the check result, which is agent configuration, outside this
  project.

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
  context.ts                server-scoped state shared by the tools
  logger.ts                 pino, bound to stderr
  tools/                    pre_action_check and verify_decision
  engine/                   analyzer + reproduction / state / decision stages
  schemas/                  zod input and output schemas, denylist
  config/                   .gatekeeperrc.json loader
  store/                    CSPRNG nonce store
  ratelimit/                sliding-window limiter
  audit/                    append-only local audit log
  types/                    domain types
tests/
  security/                 black-box ALLOW-invariant tests over real MCP
  guarantees/               mechanically enforced promises
```

`stdout` is reserved for the JSON-RPC frame stream. All logging goes to stderr.
`SKILL.md` is the agent-facing contract and is the file to read if you are
building an agent that must respect the gate.

**Architecture:** [docs/architecture.md](./docs/architecture.md) ·
**Roadmap:** [docs/phases.md](./docs/phases.md) ·
**Decisions:** [docs/decisions/](./docs/decisions/)

## License

MIT — see [LICENSE](./LICENSE).
