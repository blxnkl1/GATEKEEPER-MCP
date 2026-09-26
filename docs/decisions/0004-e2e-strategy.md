# 4. We split the end-to-end test into a protocol test and an agent test

Date: 2026-09-26

## Status

Accepted

## Context

Phase 4 shipped a single end-to-end script, `scripts/e2e/run.sh`, intended to
prove that a real coding agent can load GATEKEEPER MCP and respect its verdict.
It hung, every time, on the Claude Code branch. Two distinct causes, and one
underlying design flaw.

**The hang.** Claude Code in `--print` mode blocks waiting for a human to approve
a newly registered MCP tool. In a script there is no human, so the process never
returns. Compounding it, the script had an ad-hoc timeout with no `SIGKILL`
escalation and no portable fallback, since macOS ships no GNU `timeout`. A hang
with no bound is the worst possible failure mode for a test.

**The design flaw.** The script answered two unrelated questions in one place:

1. Does the MCP server work? Does it start, speak JSON-RPC over stdio, advertise
   `pre_action_check`, and deny an unevidenced change?
2. Does an agent obey it? Does a real agent load the server, call the tool, and
   respect the refusal?

These fail independently, and conflating them corrupts the diagnosis in both
directions. A model that refuses to call the tool, an agent that is not logged
in, and a server that does not answer `initialize` all presented as the same
failure. Meanwhile a flaky model run could mask a genuinely broken server, which
is the failure that actually matters.

A third problem compounded the first two: the script attempted an agent session
without first checking whether the agent was authenticated, so the most common
local condition, "I have not logged in to Claude Code", was reported as a test
failure.

We also had evidence from the Phase 4 runs that the agent half is inherently
noisy. The same prompt against the same build produced a completed call, a
fabricated tool result, and a refusal to call at all. A check whose outcome
varies like that cannot gate anything, but it can still be useful information
when it is clearly labelled as best effort.

## Decision

We split the suite into two scripts with different contracts, and they share one
timeout helper.

- **`mcp-protocol.sh` is mandatory.** It spawns the server, speaks JSON-RPC
  directly with a hand-written client (`protocol-client.mjs`, no SDK), and
  asserts on the response. No LLM, no credentials, no network. It is
  deterministic, finishes in about a second, and is safe to run on every commit.
  The call it makes supplies no evidence, so the only correct answer is `deny`,
  which makes "the gate is still closed" a direct assertion.
- **`agent-integration.sh` is optional and per-agent.** It runs the protocol test
  first and aborts if that fails, so a broken server can never be misreported as
  a model problem. Each agent is classified as `PASS`, `FAIL`, `TIMEOUT`, or
  `SKIPPED` with a stated reason, and only `FAIL` or `TIMEOUT` affect the exit
  code.
- **Every subprocess is bounded.** `lib/timeout.sh` is sourced by both scripts, so
  the timeout logic exists once. It prefers `timeout`, then `gtimeout`, then a
  portable background-process fallback, and the fallback escalates `SIGTERM` to
  `SIGKILL` after a grace period.
- **Authentication is a precondition, not a finding.** An auth preflight runs
  before any agent session, and a logged-out agent is `SKIPPED`.
- **Tool approval is granted explicitly.** Claude Code runs with
  `--allowedTools "mcp__gatekeeper__pre_action_check"`, because that is what
  removes the approval wait, and the prompt is placed before the flag because
  Claude Code otherwise parses the rest of the line as further flags.
- **The old script is archived**, not deleted, with a header recording what was
  wrong with it so the reasoning is not lost.

### OpenCode model variance

OpenCode's behaviour in this test depends on the model the active agent profile
selects, and the stream does not say which one it used.

`agent-integration.sh` now reports the model for every OpenCode run, in the
status table's detail column, for example
`model=google/gemini-2.5-flash, tool invoked, decision=deny`. Three sources are
tried in order: a model pinned by the caller through `GATEKEEPER_TEST_MODEL`, a
model field in the JSON stream if a future OpenCode version starts emitting one,
and otherwise `unreported` together with the first frame's key list so a later
run can diff it against this note.

On OpenCode v2.0.18 the second source yields nothing. Verified across three
runs, including one with an explicit `--model`: the top-level frame keys are
always `type,timestamp,sessionID,part`, with no model-shaped field anywhere in
the stream. The `model=` label is therefore honest about being a requested value
rather than a reported one.

A second observation matters more than the missing field. Some runs fail with
`{"type":"error","error":{"type":"provider.auth","status":403}}` before any
model is invoked, so no tool call is even possible. The script now reports that
as the reason rather than "the model declined to call the tool", which was a
misdiagnosis: there was no model to decline.

The earlier run that completed a tool call and the current runs that skip may
therefore have used different models, or the same model with a provider that was
reachable then and is not now. **This is unconfirmed and under investigation.**
It is recorded here rather than resolved, because the honest position is that the
skip is understood at the level of "the provider rejected the request", not at
the level of "this model does not call the tool".

The practical consequence for CI is unchanged by any of this. The protocol test
is the part that gates a release; the agent test is a local diagnostic.

## Consequences

CI can always run the protocol test. It is free, fast, deterministic, and it
fails for exactly one class of reason, which makes a red build immediately
diagnosable. The protocol test also checks the invariant the entire project rests
on, that stdout carries only JSON-RPC frames and logs go to stderr, on every
commit rather than occasionally.

The agent test becomes a local, best-effort check that reports what it could
and could not determine. A hung agent can no longer hide a working or a broken
server, which was the specific harm of the previous design.

`SKIPPED` is a first-class outcome rather than a soft pass. A test that reports
success because it did nothing is worse than one that admits it did nothing, and
several of the statuses in this environment are legitimately `SKIPPED`: Claude
Code is not authenticated, Codex is not installed, and Hermes cannot be driven
non-interactively without mutating the user's global config.

The cost is two scripts and one shared helper where there was one script, plus a
hand-written JSON-RPC client to maintain. The client is about 150 lines and
depends on nothing, which is the point: it is the one part of the test stack that
cannot be broken by a dependency bump.

There is one thing this decision explicitly does not fix. A model can still
report a tool result it never received, and an earlier version of the agent test
scored exactly that as a pass. The protocol test cannot detect it, because the
protocol is working correctly in that case. The failure is in how the result
reaches the model, which is a property of the agent, not of this project. It is
recorded in the test README and in the phases limitations rather than papered
over.
