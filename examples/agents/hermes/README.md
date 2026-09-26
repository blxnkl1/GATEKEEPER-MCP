# Hermes Agent

## What this wires up

Registers GATEKEEPER MCP as a local STDIO MCP server so Hermes Agent exposes
the `pre_action_check` tool.

## Config location

`~/.hermes/config.yaml`, under the `mcp_servers` key. Confirmed on Hermes Agent
v0.17.0 by running `hermes config path` and by adding a server and reading the
file back.

## Copy-paste block

CLI. Note that this command is **interactive**: it connects to the server,
enumerates the tools it finds, and then asks which of them to enable.

```bash
hermes mcp add gatekeeper --command node --args /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

Answer the discovery prompt with `Y` to enable all discovered tools.

File, from `config.yaml` in this folder. Add this under the existing
`mcp_servers` key rather than replacing it, since you likely have other servers
configured.

```yaml
mcp_servers:
  gatekeeper:
    command: node
    args:
      - /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
    enabled: true
```

`config.toml` and `config.json` in this folder are unverified alternative
shapes. Prefer `config.yaml`.

> `# UNVERIFIED`
> `config.toml` and `config.json` are placeholders based on common MCP
> conventions. Only the YAML form was observed. Do not rely on the other two.
>
> <!-- Verify against upstream docs before publishing. -->

## Verify

```bash
hermes mcp list
```

Expected: a table row for `gatekeeper` with a `node` transport and an enabled
status.

```
  Name             Transport                      Tools        Status
  ──────────────── ────────────────────────────── ──────────── ──────────
  gatekeeper       node /ABSOLUTE/PATH/...        all          ✓ enabled
```

The strongest check available without starting a session is the discovery output
from `hermes mcp add`, which prints tool names. Seeing this line means the server
was reached and the tool was found:

```
  ✓ Connected! Found 1 tool(s) from 'gatekeeper':

    pre_action_check    Gatekeeper check. Call this BEFORE modifying any code...
```

## Uninstall

```bash
hermes mcp remove gatekeeper
```

Or delete the `gatekeeper` block from `~/.hermes/config.yaml` by hand.

## Status

**PARTIALLY VERIFIED** on Hermes Agent v0.17.0.

Confirmed on this machine:

- `hermes config path` reports `~/.hermes/config.yaml`, a YAML file.
- `hermes mcp add gatekeeper --command node --args <path>` connected to the
  server, reported `Found 1 tool(s)`, and printed `pre_action_check` with its
  description. This is direct evidence that Hermes discovers the tool over
  STDIO.
- After accepting the prompt, the file contained
  `mcp_servers.gatekeeper` with `command`, an `args` list, and `enabled: true`.
- `hermes mcp list` showed the server as enabled.
- The probe was reverted afterwards and `~/.hermes/config.yaml` was restored with
  an identical sha256 checksum. Be aware that `hermes mcp add` **rewrites and
  reformats the whole YAML file**, not just the entry it adds, so back it up
  before experimenting.

Not confirmed: behaviour without a TTY. With no interactive terminal the
discovery prompt is cancelled and nothing is written, so a scripted or CI install
will silently do nothing. `config.toml` and `config.json` remain unverified.
