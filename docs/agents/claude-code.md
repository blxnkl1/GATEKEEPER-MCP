# Claude Code

Verified on Claude Code 2.1.195.

## Installation methods

Both are supported.

**CLI, recommended.**

```bash
# private to you, in ~/.claude.json
claude mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js

# shared with the team via <your-project>/.mcp.json
claude mcp add gatekeeper --scope project -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js

# with environment variables
claude mcp add gatekeeper -e PINO_LOG_LEVEL=debug -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

There is a helper in the examples folder that checks the build exists before
registering, which avoids the most common silent failure:

```bash
bash examples/agents/claude-code/install.sh /ABSOLUTE/PATH/TO/gatekeeper-mcp
```

**File edit.** Copy [`.mcp.json`](../../examples/agents/claude-code/.mcp.json) to
your project root and replace the placeholder path.

The `--` separator is required. Everything after it is the command to run;
without it Claude Code tries to parse your path as its own flags.

## Scope

| Scope | Written to | Use when |
| --- | --- | --- |
| `local` (default) | `~/.claude.json` | Private to you, per project |
| `project` | `<your-project>/.mcp.json` | Shared with the team via git |
| `user` | Claude Code user settings | Applies to all your projects |

### Project scope needs approval

A project-scope `.mcp.json` entry is reported as `Pending approval` and is **not
connected** until a human approves it on first run. This is Claude Code's trust
model for config that arrives from a repository, and it is not a fault in your
setup. Run `claude` once in the project and approve, or use `local` or `user`
scope if you would rather skip the interactive step.

## Confirming the tool is loaded

```bash
claude mcp get gatekeeper
```

Expected:

```
gatekeeper:
  Scope: Local config (private to you)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

`claude mcp list` gives a one-line summary per server and health-checks approved
entries. Neither prints tool names, so both confirm the server, not the tool. To
see `pre_action_check`, start a session and ask for the tool list.

`bash scripts/verify-agent.sh claude` wraps this check.

## Troubleshooting

**1. Status is `Pending approval`.**

Expected for project scope, not an error. Run `claude` in the project and
approve, or re-add with `--scope local`.

**2. The server is configured but Claude Code reports it as failed or missing.**

Check the entrypoint first. Claude Code starts MCP servers with an unspecified
working directory, so a relative path fails:

```bash
ls -l /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

Also confirm you are in the project you think you are: project scope resolves
relative to the current working directory, so a sibling directory sees a
different `.mcp.json`.

**3. `npx` hangs or a cached build goes stale.**

This bites when a config uses `npx`. If you point at a local build, as this
project recommends before Phase 4, it cannot happen. If you still use `npx`, a
stale npx cache is the usual cause: clear it with `npm cache clean --force`, or
bypass the cache by calling `node <path>/dist/index.js` directly. A `PATH`
problem is the other common cause: Claude Code inherits the environment of the
shell it was launched from, so a `node` that works in your terminal may not
resolve in a GUI-launched Claude Code. Use an absolute path to the `node`
binary if you hit that.

## Open Questions

- Are `type: "stdio"` and `env: {}` optional? The CLI writes both; a minimal
  `{ "command", "args" }` form was not tested.
- Can Claude Code enforce that a tool is called before an edit, or is the gate
  advisory? Claude Code has permission rules and hooks, so enforcement may be
  possible, but nothing was tested here.
- Is there a non-interactive way to pre-approve a project `.mcp.json`, for CI?
  Not found.

## Status

**VERIFIED** on 2.1.195. `claude mcp add -s project` wrote exactly the keys in
the example, and `claude mcp get` read them back correctly, including the scope,
type, command, and args.
