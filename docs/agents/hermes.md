# Hermes Agent

Verified in part on Hermes Agent v0.17.0.

## Configuration format

Hermes uses **YAML**, at `~/.hermes/config.yaml`, under an `mcp_servers` key.
Confirm the path for your install with:

```bash
hermes config path
```

This was confirmed empirically: `hermes mcp add gatekeeper --command node --args
<path>` wrote exactly these keys.

```yaml
mcp_servers:
  gatekeeper:
    command: node
    args:
      - /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
    enabled: true
```

`config.toml` and `config.json` variants are in
[`examples/agents/hermes/`](../../examples/agents/hermes/) and are labelled
`UNVERIFIED`. They are guesses based on common MCP conventions. Prefer the YAML.

## Installation methods

**CLI, recommended, but interactive.**

```bash
hermes mcp add gatekeeper --command node --args /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

`--args` must be the last option, since it swallows everything after it.

The command is discovery-first. It connects to the server, enumerates the tools
it finds, and asks which to enable:

```
  ✓ Connected! Found 1 tool(s) from 'gatekeeper':

    pre_action_check    Gatekeeper check. Call this BEFORE modifying any code...

  Enable all 1 tools? [Y/n/select]:
```

Answer `Y` to enable everything. This is also the best tool-level verification
available on any of the agents here, because it prints the tool name.

**File edit.** Add the `gatekeeper` block under the existing `mcp_servers` key
in `~/.hermes/config.yaml`. Do not replace the whole file: you probably have
other servers, and `enabled: true` matters.

## Scope

Single file. `~/.hermes/config.yaml` appears to hold both user-wide and
per-project MCP configuration; no separate project scope was found. If Hermes
supports per-project overrides, that was not determined.

## Confirming the tool is loaded

```bash
hermes mcp list
```

Expected row:

```
  Name             Transport                      Tools        Status
  ──────────────── ────────────────────────────── ──────────── ──────────
  gatekeeper       node /ABSOLUTE/PATH/...        all          ✓ enabled
```

This confirms the server is registered. It does not print tool names. For
tool-level confirmation, re-run `hermes mcp add` and read its discovery output,
or start a session.

`bash scripts/verify-agent.sh hermes` wraps the list check.

A note on `Tools: all`: that column reports how many tools are enabled from the
server, not their names.

## Troubleshooting

**1. `hermes mcp add` printed nothing and wrote nothing.**

It cancelled at the discovery prompt. With no interactive terminal, the prompt
is cancelled and the command exits without saving, so a scripted or CI install
silently does nothing. Run it in a real terminal. Confirm the outcome with
`hermes mcp list`.

**2. The entry is present but disabled, or tools are missing.**

Hermes gates tools individually. If you answered `n` or `select` at the
discovery prompt, the server may be saved with no tools enabled, which makes
`pre_action_check` invisible to the model even though the server is connected.
Re-run `hermes mcp add` and enable all, or use `hermes mcp configure` to toggle
tool selection afterwards.

**3. `hermes mcp add` reformatted your whole config.**

This is real and observed: the add command rewrites `config.yaml`, not just the
entry it adds. On this machine it moved and requoted unrelated entries. Back the
file up before experimenting:

```bash
cp -p ~/.hermes/config.yaml ~/.hermes/config.yaml.bak
```

If something goes wrong, restore it and verify the checksum is unchanged:

```bash
shasum -a 256 ~/.hermes/config.yaml ~/.hermes/config.yaml.bak
```

## Open Questions

- Is there a per-project MCP scope, or only the single user file?
- Can the discovery prompt be pre-answered non-interactively, for CI?
- Do the `config.toml` and `config.json` forms work at all?
- Can Hermes enforce a tool call before a file edit, or is the gate advisory?
- Does `hermes mcp test <name>` exist as a lighter-weight connection check than
  a full `mcp add`? It appears in `hermes mcp --help` but was not exercised.

## Status

**PARTIALLY VERIFIED** on v0.17.0.

Confirmed: the config path and YAML format, the `command`/`args`/`enabled` keys
written by the CLI, a live connection that reported `Found 1 tool(s)` and printed
`pre_action_check` by name, and a `hermes mcp list` row showing the server
enabled. The probe was reverted and the config restored with an identical sha256.

Not confirmed: non-interactive installation, per-project scope, and the TOML and
JSON variants.
