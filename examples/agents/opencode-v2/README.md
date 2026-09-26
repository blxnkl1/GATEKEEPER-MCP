# OpenCode v2

## What this wires up

Registers GATEKEEPER MCP as a local STDIO MCP server so OpenCode exposes the
`pre_action_check` tool.

## Config location

- Project scope: `<your-project>/opencode.json` (created by the CLI).
- Global scope: `~/.config/opencode/opencode.json`.

The global path honours `XDG_CONFIG_HOME`, which is what makes isolated testing
possible. Note that OpenCode also reads an existing `opencode.jsonc` in the same
directories, and many installs keep their global config in that file. Either
extension is read; the CLI writes the plain `.json` one.

## Copy-paste block

CLI, which is the recommended path because it writes the schema for you:

```bash
opencode mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
opencode mcp add gatekeeper --global -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

File, from `opencode.json` in this folder. Replace the placeholder path first.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "gatekeeper": {
        "type": "local",
        "command": ["node", "/ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js"],
        "environment": {}
      }
    }
  }
}
```

> Note the nesting. The key is `mcp.servers.<name>`, not `mcp.<name>`. This was
> confirmed by running `opencode mcp add` on OpenCode v2.0.18 and reading the
> file it wrote. Earlier revisions of this project's README showed `mcp.<name>`,
> which v2 does not use.

## Verify

```bash
opencode mcp list
```

Expected line:

```
✓ gatekeeper           connected
```

`connected` means OpenCode launched the process and completed the MCP handshake.
A server that fails to start shows `failed` instead.

This check confirms the server is registered and reachable. It does **not** print
tool names, so it does not by itself prove `pre_action_check` is exposed. To
confirm the tool, start an OpenCode session and ask it to list its tools.

## Uninstall

```bash
opencode mcp remove gatekeeper            # project scope
opencode mcp remove gatekeeper --global   # global scope
```

Or delete the `gatekeeper` entry from `opencode.json` by hand.

## Status

**VERIFIED** on OpenCode v2.0.18.

Confirmed on this machine:

- `opencode mcp add gatekeeper -- node <path>` writes
  `mcp.servers.gatekeeper` with `type: "local"` and a `command` array.
- `opencode mcp add --env FOO=bar` adds an `environment` object, so that key is
  valid. The `enabled` boolean is **not** emitted by the CLI and its support is
  unconfirmed, so it is omitted here.
- `opencode mcp list` reported `✓ gatekeeper connected`, meaning the server was
  spawned and the handshake completed.
- `--global` writes to `$XDG_CONFIG_HOME/opencode/opencode.json`, verified with
  an isolated `XDG_CONFIG_HOME` so the real user config was not modified.
- A pre-existing global `~/.config/opencode/opencode.jsonc` on this machine uses
  the same `mcp.servers.<name>` nesting with `type: "local"` and a `command`
  array, which independently corroborates the shape.

Not confirmed: the behaviour of OpenCode v1, which may differ. See
`../opencode-v1/`. Tool-level visibility inside a session was not checked.
