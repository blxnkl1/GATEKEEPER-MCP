# End-to-end tests

Two tests with very different properties, deliberately kept apart.

| | Protocol | Agent integration |
| --- | --- | --- |
| Script | `mcp-protocol.sh` | `agent-integration.sh` |
| Uses an LLM | No | Yes |
| Needs credentials | No | Yes |
| Needs network | No | Yes |
| Deterministic | Yes | No |
| Cost | Free | Tokens and time |
| Safe for CI | Yes | No |
| Runtime | ~1s | ~10s to 3 min |

```bash
bash scripts/e2e/mcp-protocol.sh        # always run this
bash scripts/e2e/agent-integration.sh   # best effort, optional
```

## Why two tests

The Phase 4 version of this suite was a single script that hung on the Claude
Code branch, and it had a design flaw behind the hang: it answered two unrelated
questions at once.

1. **Does the MCP server work?** Does it start, speak JSON-RPC over stdio,
   advertise `pre_action_check`, and deny an unevidenced change?
2. **Does an agent obey it?** Does a real coding agent load the server, call the
   tool, and respect the refusal?

Those fail independently. A flaky model can mask a broken server, and a broken
server looks like a flaky model. Worse, an agent CLI that blocks forever hides
both answers behind a hang.

So the protocol half is now mandatory, free, deterministic, and safe for CI. The
agent half is optional, per-agent, and honest about what it could not determine.
`agent-integration.sh` runs the protocol test first and aborts if it fails,
precisely so a broken server can never be reported as a model problem.

## The protocol test

`mcp-protocol.sh` spawns `node dist/index.js` and drives it with a hand-written
JSON-RPC client, `protocol-client.mjs`. No SDK, no agent, no model. It performs
`initialize`, `tools/list`, and `tools/call`, then asserts on the response.

The call it makes supplies no evidence at all, so the correct verdict is `deny`
with `evidence.state: "unverifiable"`. That assertion is the important one: if it
ever returns `allow`, the gate is open.

It also asserts that stdout carried only JSON-RPC frames and that the server
logged to stderr. Those are the invariant that the whole project rests on, and
they are cheap to check on every commit.

## The agent integration test

`agent-integration.sh` runs each eligible agent in a throwaway git repository in
`$TMPDIR` with a project-scope config. No global or user agent config is read or
written, and the temp repository is removed on every exit path.

The same no-evidence call is used, so `deny` is the only correct answer. An
agent passes when it invoked the tool **and** the response carried that denial.

### Per-agent invocation

Paths below are placeholders. `<REPO>` is the absolute path to this checkout,
and an absolute path is required: MCP servers start with an unspecified working
directory, so a relative path will not resolve.

**OpenCode** — native MCP tool event:

```bash
opencode mcp add gatekeeper -- node <REPO>/dist/index.js
opencode run "Call pre_action_check with taskDescription='x', proposedChange='y', affectedFiles=[]. Report the decision." \
  --format json
```

The test accepts two invocation shapes, because this agent has two. A native
tool event is `gatekeeper.pre_action_check` in the JSON stream. Some OpenCode
model profiles instead reach MCP tools through the Code Mode bridge, which shows
up as `tools.opencode[`. Both are real calls; they are just different routes to
the same server.

**Claude Code** — the prompt must come before `--allowedTools`, or the rest of
the line is parsed as further flags:

```bash
claude mcp add gatekeeper -- node <REPO>/dist/index.js
claude --print "Call pre_action_check with taskDescription='x', proposedChange='y', affectedFiles=[]. Report the decision." \
  --allowedTools "mcp__gatekeeper__pre_action_check"
```

`--allowedTools` is not optional. Without it Claude Code blocks in `--print`
mode waiting for a human to approve a newly registered MCP tool, and a script has
no human. That was the original hang.

**Codex** and **Hermes** are skipped with a stated reason. Codex has no
verified config format, and guessing one produces a test that fails for reasons
unrelated to this project. Hermes registers servers only through an interactive
prompt that cancels when there is no TTY, so exercising it would mean editing the
user's global config from a test.

## Status vocabulary

| Status | Meaning | Exit effect |
| --- | --- | --- |
| `PASS` | The agent invoked the tool and the response carried the denial. | Success |
| `FAIL` | The agent was reachable and eligible but did not do the right thing. | Exit 1 |
| `TIMEOUT` | The agent exceeded its budget. Usually a blocked approval prompt. | Exit 1 |
| `SKIPPED` | Not installed, not authenticated, or the model cannot see the tool. | Not a failure |

`SKIPPED` is deliberately not a soft `PASS`. A test that reports success because
it did nothing is worse than one that admits it did nothing.

## Known limitations

- **Claude Code needs `claude login`.** Without it the probe reports
  `Not logged in` and the agent is skipped. The auth probe is
  `claude --print "hi"`: passing an empty `--allowedTools ""` swallows the prompt
  argument and the probe then fails for the wrong reason, which looks identical
  to being logged out.
- **OpenCode needs a working model provider**, and the active agent profile
  matters. On the machine where this was written, `opencode mcp list` reported
  `gatekeeper connected` while the model under the default profile stated it had
  no `pre_action_check` tool and never called it. The test reports that as
  `SKIPPED: server connected, but the model did not surface the tool to itself`,
  which is exactly what happened. The same setup has been observed invoking the
  tool successfully under a different profile, so this is a property of the
  agent and model configuration, not of the server.
- **Model behaviour is not reproducible.** The same prompt against the same build
  has produced a completed call, a fabricated result, and a refusal to call at
  all. This test is a smoke signal, never a release gate.
- **A model can report a tool result it never received.** An earlier version of
  this suite scored that as a pass. If a tool call returns nothing, or the result
  looks inconsistent with the arguments, that is a finding worth reporting rather
  than a reason to trust the transcript.
- **Only one agent runs per invocation.** There is no matrix mode.
- **Timeouts are best-effort.** macOS ships no GNU `timeout`, so
  `lib/timeout.sh` falls back to a background process with a watcher. It escalates
  `SIGTERM` to `SIGKILL` after a grace period, because a child that ignores
  `SIGTERM` would otherwise defeat the timeout entirely. Exit status `124` means
  timed out.

## Files

```
scripts/e2e/
├── mcp-protocol.sh        mandatory, no LLM
├── protocol-client.mjs    hand-written JSON-RPC client, no SDK
├── agent-integration.sh   optional, per-agent, uses an LLM
├── lib/timeout.sh         shared portable timeout, sourced by both
├── archive/run.sh         superseded, kept for reference only
└── README.md              this file
```
