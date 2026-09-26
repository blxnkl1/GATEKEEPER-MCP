# Claude Code

## What this wires up

Registers GATEKEEPER MCP as a local STDIO MCP server so Claude Code exposes the
`pre_action_check` tool.

## Config location

- Project scope: `<your-project>/.mcp.json`, shared with the team via version
  control.
- Local scope: `~/.claude.json`, private to you, not shared.
- User scope: the Claude Code user settings file.

## Copy-paste block

CLI, which is the recommended path because it writes the schema for you:

```bash
bash install.sh /ABSOLUTE/PATH/TO/gatekeeper-mcp              # local scope
bash install.sh /ABSOLUTE/PATH/TO/gatekeeper-mcp project      # writes .mcp.json
claude mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

File, from `.mcp.json` in this folder. Replace the placeholder path first.

```json
{
  "mcpServers": {
    "gatekeeper": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

## Verify

```bash
claude mcp get gatekeeper
```

Expected output includes the scope, type, command, and args:

```
gatekeeper:
  Scope: Local config (private to you)
  Status: ✔ Connected
  Type: stdio
  Command: node
  Args: /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

`claude mcp list` works too and shows a one-line summary per server.

If the status reads `Pending approval`, the entry is fine but Claude Code has
not been told to trust it. Run `claude` once in that project and approve.

## Uninstall

```bash
claude mcp remove gatekeeper -s local     # match the scope you added it with
claude mcp remove gatekeeper -s project
```

Or delete the `gatekeeper` entry from `.mcp.json` by hand.

## Status

**VERIFIED** on Claude Code 2.1.195.

Confirmed on this machine:

- `claude mcp add gatekeeper -s project -- node <path>` wrote `.mcp.json` with
  exactly the keys shown above: `type: "stdio"`, `command`, `args`, `env`.
- `claude mcp get gatekeeper` parsed the entry back and reported the scope, type,
  command and args correctly, and printed its own removal command.
- The `--` separator before the command is required, and `-s` accepts
  `local`, `user`, or `project` with `local` as the default.

One behaviour worth knowing, which is not a defect: a project-scope `.mcp.json`
entry reports `Pending approval` and is **not** connected until a human approves
it on first run. This is Claude Code's trust model for shared config. Use the
`local` or `user` scope to avoid the interactive step.

Not confirmed: whether `type` and `env` may be omitted. They are written by the
CLI and are safe to keep, but a minimal `{ "command", "args" }` form was not
tested.
