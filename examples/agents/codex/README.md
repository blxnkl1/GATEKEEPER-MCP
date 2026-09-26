# Codex

## What this wires up

Registers GATEKEEPER MCP as a local STDIO MCP server so Codex exposes the
`pre_action_check` tool.

## Config location

`~/.codex/config.toml`, the Codex user configuration file. This path is **not**
confirmed; see the status section.

## Copy-paste block

```toml
[mcp_servers.gatekeeper]
command = "node"
args = ["/ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js"]
```

Or, if your Codex build ships an MCP subcommand with the same shape as the other
agents:

```bash
codex mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

The CLI line above is a guess. `codex` was not available on the machine where
this example was written, so run `codex --help` and `codex mcp --help` before
relying on it.

> `# UNVERIFIED`
> Codex is not installed here, so nothing in this file was executed. The
> `[mcp_servers.<name>]` table is based on common MCP conventions and on what
> other agents use, not on observation. The key could be `mcp_servers` or
> `mcp.servers`, and Codex may require an explicit `type = "stdio"` or a
> `startup_timeout_sec` field.
>
> <!-- Verify against upstream docs before publishing. -->

## Verify

Unknown. `codex --help` was not available to check whether a non-interactive
listing command exists. Try, in order:

```bash
codex mcp list
codex --help | grep -i mcp
```

If neither works, start a Codex session and ask it to list its available tools,
looking for `pre_action_check`. Once you have a working command, add it to
`scripts/verify-agent.sh` so the check is repeatable.

## Uninstall

```bash
codex mcp remove gatekeeper
```

If that subcommand does not exist, delete the `[mcp_servers.gatekeeper]` table
from `~/.codex/config.toml` by hand.

## Status

**UNVERIFIED**.

`codex` is not installed on this machine. What specifically needs checking:

1. The real config path. `~/.codex/config.toml` is the commonly cited location
   but was not confirmed.
2. The table name, `mcp_servers` versus `mcp.servers`.
3. Whether a `type` or transport field is mandatory.
4. Whether a non-interactive tool-listing command exists, and what it is called.
5. The removal subcommand name.
