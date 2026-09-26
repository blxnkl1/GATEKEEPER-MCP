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
| OpenCode v2 | VERIFIED | `opencode.json` | [docs/agents/opencode.md](./opencode.md) |
| Codex | UNVERIFIED | `~/.codex/config.toml` (unconfirmed) | [docs/agents/codex.md](./codex.md) |
| Claude Code | VERIFIED | `~/.claude.json` / `.mcp.json` | [docs/agents/claude-code.md](./claude-code.md) |
| Hermes Agent | PARTIALLY VERIFIED | `~/.hermes/config.yaml` | [docs/agents/hermes.md](./hermes.md) |

Configs that are not yet fully verified are marked accordingly in each guide.

### What the statuses mean

- **VERIFIED** — the config was written by the agent's own CLI or read back by
  it, and the server was observed to connect. Versions are named in each guide.
- **PARTIALLY VERIFIED** — the connection and tool discovery were observed, but
  some part of the config format or the verification path could not be confirmed.
- **UNVERIFIED** — the agent was not available on the machine where these docs
  were written, so nothing was observed. The example is a best-effort starting
  point and is labelled as such in the file itself.

### Versions observed

| Agent | Version | How it was checked |
| --- | --- | --- |
| OpenCode | v2.0.18 | `opencode --version`, `opencode mcp add`, `opencode mcp list` |
| Claude Code | 2.1.195 | `claude --version`, `claude mcp add -s project`, `claude mcp get` |
| Hermes Agent | v0.17.0 | `hermes --version`, `hermes config path`, `hermes mcp add`, `hermes mcp list` |
| Codex | not installed | nothing was checked |
| OpenCode v1 | not installed | nothing was checked |

MCP configuration formats change between major versions. Re-check the status
column when you upgrade an agent, and prefer the `mcp add` CLI over hand-editing
a file wherever one exists: the CLI writes whatever the installed version
actually expects.

## Before you start

GATEKEEPER MCP is not on npm yet. Until Phase 4, every snippet points at a
local build:

```bash
git clone https://github.com/<YOUR NAME>/gatekeeper-mcp.git
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
