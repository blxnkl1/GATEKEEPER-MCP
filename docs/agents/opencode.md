# OpenCode

Covers OpenCode v1 and v2. The two differ, and the difference matters.

## The key difference

| Version | Config nesting | Confidence |
| --- | --- | --- |
| v2.0.18 | `mcp.servers.<name>` | Observed on a real install |
| v1 | `mcp.<name>` | Not observed; documented shape |

This is the single most likely cause of a silently broken setup. If
`opencode mcp list` shows nothing after you have written a config by hand, you
are probably nesting it the way the other version expects.

## Installation methods

Both are supported.

**CLI, recommended.** It writes the shape your installed version expects, which
removes the whole v1-versus-v2 question.

```bash
# project scope: writes <your-project>/opencode.json
opencode mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js

# global scope: writes ~/.config/opencode/opencode.json
opencode mcp add gatekeeper --global -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

Add environment variables with `--env KEY=value` before the `--`, for example
`PINO_LOG_LEVEL=debug` while you are diagnosing something.

**File edit.** Copy the right file from [`examples/agents/`](../../examples/agents/)
and replace the placeholder path.

## Scope

| Scope | File | Use when |
| --- | --- | --- |
| Project | `<your-project>/opencode.json` | The gate belongs to one repository |
| Global | `~/.config/opencode/opencode.json` | You want the gate everywhere |

OpenCode also reads an existing `opencode.jsonc` in the same locations, and many
installs keep their global config there. Both extensions are read; the CLI writes
the plain `.json` one. A global `opencode.jsonc` on the machine where this was
verified uses the same `mcp.servers.<name>` nesting, which independently
corroborates the shape.

`mcp.timeout.startup` is also available and sets the server start-up timeout in
milliseconds. GATEKEEPER MCP starts in well under a second, so the default is
fine; raise it only if you are debugging on a heavily loaded machine.

The global path honours `XDG_CONFIG_HOME`, which makes it possible to test
OpenCode's MCP handling without touching your real config:

```bash
XDG_CONFIG_HOME=$(mktemp -d)/xdg opencode mcp add gatekeeper --global -- node /path/dist/index.js
```

One caveat found while testing: `opencode mcp add --global` honours
`XDG_CONFIG_HOME` when writing, but `opencode mcp list` did not appear to read
the entry back from an isolated location. Verify a global install from a real
terminal rather than trusting an isolated test.

## Confirming the tool is loaded

```bash
opencode mcp list
```

Expected:

```
✓ gatekeeper           connected
```

A server that could not start shows `failed`. This is the only non-interactive
check OpenCode offers, and it reports server entries, not tool names. To see
`pre_action_check` in a session, start OpenCode and ask it to list its tools.

`bash scripts/verify-agent.sh opencode` wraps this check.

## Troubleshooting

**1. `opencode mcp list` shows nothing, but the file has an entry.**

Almost always the nesting. v2 wants `mcp.servers.gatekeeper`; the v1 shape
`mcp.gatekeeper` is silently ignored rather than reported as an error. Check
which version you have with `opencode --version` and use the matching example.
Failing that, let the CLI write the file for you and delete your hand-written
entry.

**2. Status is `failed`, or the server never appears.**

Work through these in order:

```bash
# does the build exist?
ls -l /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js

# does it start and answer a handshake by hand?
node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

The second command should print a JSON log line to stderr and then sit waiting
for input, which is correct. If it exits immediately, the build is broken: run
`npm ci && npm run build` in the repository. A relative path is also a common
cause, since MCP servers start with an unspecified working directory.

**3. It connects but the agent never calls the tool.**

The server being connected does not mean the model will use it. Two things
help, in order of effect: put the gate in the tool description or in your
`AGENTS.md` / `CLAUDE.md` so the agent knows to call it before editing, and make
sure the agent is not silently ignoring MCP tools. OpenCode prints server logs
with `--print-logs`, which will show the gatekeeper's stderr if you need to see
whether the tool list was fetched.

## Open Questions

- Does OpenCode v1 accept the `enabled` boolean? The v2 CLI does not emit it and
  its support was not tested.
- Does v1 ship `opencode mcp list`? If it does not, there is no non-interactive
  check for v1 and `verify-agent.sh` will exit `2`.
- Does v1 support `--global` on `mcp add`?
- Can OpenCode enforce a tool call before an edit, or is the gate advisory only?
  This matters: if advisory, the gate reduces Action Bias but cannot prevent it.

## Status

- **OpenCode v2: VERIFIED** on v2.0.18. Config shape, `--global` behaviour, and a
  `connected` status were all observed directly.
- **OpenCode v1: UNVERIFIED.** Not installed. Everything above about v1 is the
  documented shape, not an observation.
