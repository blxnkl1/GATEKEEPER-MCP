# Agent integration

One guide per coding agent. Each covers how to register GATEKEEPER MCP, where
the config lives, how to confirm the server is loaded, and what to do when it
is not.

- [OpenCode (v1 and v2)](./opencode.md)
- [Codex](./codex.md)
- [Claude Code](./claude-code.md)
- [Hermes Agent](./hermes.md)
- [Manual verification checklist](./VERIFICATION.md)

Copy-paste configs live in [`examples/agents/`](../../examples/agents/).

## Compatibility matrix

| Agent | Status | Config path | Guide |
| --- | --- | --- | --- |
| OpenCode v1 | UNVERIFIED | `opencode.json` | [docs/agents/opencode.md](./opencode.md) |
| OpenCode v2.0.18 | VERIFIED | `opencode.json` | [docs/agents/opencode.md](./opencode.md) |
| Codex | UNVERIFIED | `~/.codex/config.toml` (unconfirmed) | [docs/agents/codex.md](./codex.md) |
| Claude Code 2.1.195 | VERIFIED (config) | `~/.claude.json` / `.mcp.json` | [docs/agents/claude-code.md](./claude-code.md) |
| Hermes Agent v0.17.0 | PARTIALLY VERIFIED | `~/.hermes/config.yaml` | [docs/agents/hermes.md](./hermes.md) |
| Any MCP-compatible agent | COMPATIBLE BY DESIGN | agent-specific | this page |

Configs that are not yet fully verified are marked accordingly in each guide.

### What each status means here

- **OpenCode v2.0.18 — VERIFIED.** Registered with the agent's own CLI, and
  `opencode mcp list` reported `gatekeeper connected`. The tool has been observed
  being invoked. Scope of that claim: the model under the *default* agent profile
  does not always surface the tool to itself, which is a property of the profile
  rather than of the server. See [scripts/e2e/README.md](../../scripts/e2e/README.md).
- **Claude Code 2.1.195 — VERIFIED (config).** The config format is confirmed:
  `claude mcp add` writes the documented keys, `claude mcp get` reads them back,
  and `claude mcp list` reported `Connected` for a correctly configured server. A
  tool call has **not** been observed end to end on this machine, because the
  installed CLI is not authenticated. Authentication is separate from config
  correctness and varies per user.
- **Hermes Agent v0.17.0 — PARTIALLY VERIFIED.** The YAML format and the
  `mcp_servers` keys are confirmed, and a connection handshake was observed
  listing `pre_action_check` by name. Non-interactive installation is not
  possible, so it cannot be driven from a script.
- **OpenCode v1 and Codex — UNVERIFIED.** Not installed on the test machine.
  Nothing about their config formats was observed.
- **Any MCP-compatible agent — COMPATIBLE BY DESIGN.** GATEKEEPER implements the
  standard MCP stdio transport. Any agent that supports MCP stdio can use it;
  only the config syntax differs. Nothing vendor-specific appears in the server.

### Versions observed

| Agent | Version | How it was checked |
| --- | --- | --- |
| OpenCode | v2.0.18 | `opencode mcp add`, `opencode mcp list`, `opencode run` |
| Claude Code | 2.1.195 | `claude mcp add -s project`, `claude mcp get`, `claude mcp list` |
| Hermes Agent | v0.17.0 | `hermes config path`, `hermes mcp add`, `hermes mcp list` |
| Codex | not installed | nothing was checked |
| OpenCode v1 | not installed | nothing was checked |

MCP configuration formats change between major versions. Re-check the status
column when you upgrade an agent, and prefer the `mcp add` CLI over hand-editing
a file wherever one exists: the CLI writes whatever the installed version
actually expects.

## Before you start

These snippets point at a local build, which is what you want when working on the
project itself. For day-to-day use, install from npm and use
`npx -y gatekeeper-mcp` instead:

```bash
git clone https://github.com/blxnkl1/GATEKEEPER-MCP.git
cd gatekeeper-mcp
npm ci
npm run build
```

Then substitute the absolute path to that checkout wherever a snippet shows
`/ABSOLUTE/PATH/TO/gatekeeper-mcp`. An absolute path is required: MCP servers
are started with an unspecified working directory, so a relative path such as
`./dist/index.js` will not resolve.

## The one universal check

`scripts/verify-agent.sh` checks that the server is registered and reports what
it found:

```bash
bash scripts/verify-agent.sh opencode    # 0 = registered, 1 = absent, 2 = cannot check
bash scripts/verify-agent.sh claude
bash scripts/verify-agent.sh hermes
bash scripts/verify-agent.sh codex
```

Read [Verification honesty](#verification-honesty) below before treating a
passing result as more than it is.

## Verification honesty

No agent inspected here prints tool names in its non-interactive listing. They
list **server entries** and a connection status. So `verify-agent.sh` passing
means "the server is registered and reachable", not "the model can see
`pre_action_check`".

To confirm the tool itself, you need one of:

- a session, asking the agent to list its tools; or
- Hermes only, where `hermes mcp add` prints the tools it discovers during the
  connection handshake.

This distinction is deliberate and is why the script prints which of the two it
matched rather than a bare pass.
