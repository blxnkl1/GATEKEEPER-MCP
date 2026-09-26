# Codex

**Nothing on this page was verified.** Codex was not installed on the machine
where these docs were written. Every snippet is a best-effort starting point
labelled `UNVERIFIED` in the example file too.

If you have Codex working, please open an issue or a pull request with the real
values so this page can be corrected.

## Installation methods

**File edit, the assumed method.** `~/.codex/config.toml`:

```toml
[mcp_servers.gatekeeper]
command = "node"
args = ["/ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js"]
```

**CLI, unconfirmed.** If your build has an MCP subcommand with a shape like the
other agents:

```bash
codex mcp add gatekeeper -- node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

Do not trust that line without checking `codex --help` first.

## Scope

Unknown. TOML supports the notion, but whether Codex exposes a project versus
user MCP config, and which files those are, was not determined.

## Confirming the tool is loaded

Unknown. No non-interactive listing command was confirmed to exist. Try:

```bash
codex mcp list
codex --help | grep -i mcp
```

If neither works, start a Codex session and ask it to list its tools, looking for
`pre_action_check`.

## Troubleshooting

These are the three failure modes that broke the other agents and are the most
likely to apply here too. They are written as general diagnostics because no
Codex-specific behaviour is known.

**1. Nothing appears in the listing.**

Confirm the file Codex actually reads. Run `codex --help` and look for a config
or home-directory flag, and check whether the path is `~/.codex/config.toml` or
somewhere else. A config in the wrong place is ignored silently, with no warning.
Then check the table name: `[mcp_servers.gatekeeper]` and `[mcp.servers.gatekeeper]`
are not the same thing and only one will be read.

**2. The server is registered but never starts.**

Check the entrypoint and use an absolute path:

```bash
ls -l /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
node /ABSOLUTE/PATH/TO/gatekeeper-mcp/dist/index.js
```

A valid server prints a log line to stderr and then waits for input. It should
exit non-zero or print nothing if the build is broken. Also confirm the TOML
parses; a stray comma or an unquoted path is a silent failure in several TOML
readers.

**3. It connects but the agent ignores the tool.**

A registered server does not oblige the model to use it. Put the rule in the
agent's instruction file so it knows to call `pre_action_check` before editing,
and confirm the tool is actually visible in a session. If Codex supports
approval prompts for MCP tools, an unapproved tool is invisible to the model
while still appearing in the config.

## Open Questions

- What is the real config path?
- Is the table `mcp_servers` or `mcp.servers`?
- Is an explicit transport or `type` field required?
- Is there a non-interactive tool-listing command, and what is it called?
- What is the removal subcommand?
- Can Codex enforce a tool call before a file edit?

## Status

**UNVERIFIED.** Codex is not installed here. All five questions above need
answering by someone with a working Codex before this page can claim anything.
