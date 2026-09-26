# OpenCode v1

## What this wires up

Registers GATEKEEPER MCP as a local STDIO MCP server so OpenCode v1 exposes the
`pre_action_check` tool.

## Config location

- Project scope: `<your-project>/opencode.json`.
- Global scope: `~/.config/opencode/opencode.json`.

## Copy-paste block

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gatekeeper": {
      "type": "local",
      "command": ["node", "/ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js"],
      "enabled": true
    }
  }
}
```

The CLI equivalent, if your build has it:

```bash
opencode mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

> `# UNVERIFIED`
> OpenCode v1 is not installed on the machine where this example was written, so
> nothing in this file was observed. The nesting shown here is `mcp.<name>`,
> which is the shape OpenCode v1 is documented to use. The v2 CLI writes
> `mcp.servers.<name>` instead, so the two differ. If `opencode mcp list` shows
> nothing, you are probably on the other shape: try moving the entry under
> `mcp.servers`.
>
> <!-- Verify against upstream docs before publishing. -->

## Verify

```bash
opencode mcp list
```

Expected line:

```
✓ gatekeeper           connected
```

## Uninstall

```bash
opencode mcp remove gatekeeper
```

Or delete the `gatekeeper` entry from `opencode.json` by hand.

## Status

**UNVERIFIED**.

OpenCode v1 is not installed here, so no part of this file was executed. What
specifically needs checking:

1. Whether v1 nests the entry at `mcp.gatekeeper` or `mcp.servers.gatekeeper`.
   These are not interchangeable and only one is right for a given build.
2. Whether v1 accepts the `enabled` boolean.
3. Whether v1 ships `opencode mcp list` at all; if not, tool availability must
   be confirmed by starting a session.
