# 6. Anti-fabrication: nonces with advisory and enforced modes

Date: 2026-09-26

## Status

Accepted

## Context

In Phase 4 a real agent, OpenCode v2.0.18, was asked to call `pre_action_check`
and report the decision. The server returned:

```json
{ "decision": "deny", "evidence": { "state": "not_reproduced" },
  "reason": "The reproduction command succeeded; no failure was observed..." }
```

The agent reported back `allow`, with an `evidence` object and a `reason` that
the server never produced. The gate had worked; the report of it had not.

Nothing in the protocol could catch this. The agent's own account of what it did
was the only evidence available, and a fluent plausible-sounding denial-turned-
allow is exactly what a model produces when it has drifted from the tool result.
Worse, the Phase 4 test scored that run as a **pass**, because the agent's output
happened to contain the word "deny" and because it had not modified any files.
Two independent checks agreed, and both were measuring the wrong thing.

There is a structural reason this is hard. MCP is a request/response protocol
over stdio. The server has no channel to the filesystem the agent will edit, no
way to veto a write, and no way to observe one. A server in this position can
detect misreporting and can make misreporting *inconvenient*, and that is the
honest ceiling.

## Options considered

**(a) Advisory only.** Every reply carries a nonce; the agent may call
`verify_decision` before reporting; mismatches are recorded. Nothing changes
about the agent's ability to edit files. Cheapest, no risk of wedging a session,
and useless against an agent that simply does not call the verifier.

**(b) Enforced only.** The server refuses to answer until the previous decision
was verified. Maximum pressure to comply, and it punishes the most likely
innocent case: an agent that was told the tool is optional, followed the
instructions, edited the file, and never verified because nothing asked it to.
Defaulting to this would break working setups to catch a rarer one, and the
resulting support burden would land on exactly the users with the least
patience for it.

**(c) Hybrid.** Advisory by default, enforced opt-in. Detection is always on and
costs nothing; the pressure to comply is available to anyone who wants it.

We chose (c).

## Decision

**Every `pre_action_check` response carries a `nonce`**: 16 bytes from
`crypto.randomBytes`, base64url encoded, 22 characters. It is issued by the tool
layer, not the engine, because a nonce is a statement about one reply to one
caller rather than a policy outcome, and the engine is frozen.

**`verify_decision` is a second tool.** Given a nonce and a decision, it reports
whether that decision is the one the server issued. Three outcomes:

| Outcome | Meaning | Audit event |
| --- | --- | --- |
| `valid: true` | The claim matches the issued decision | `verify_decision` |
| `valid: false`, no `originalDecision` | Unknown or already-consumed nonce | `verify_decision` |
| `valid: false`, with `originalDecision` | The claim contradicts the server | `fabrication_suspected` |

Nonces are single use. A replay returns invalid, so one real decision cannot be
laundered into many claims.

**Advisory mode is the default.** `verify_decision` exists and mismatches are
recorded, but nothing requires the agent to call it.

**Enforced mode is opt-in** via `mode: "enforced"`. A new `pre_action_check` call
arriving while a previous decision is unconsumed and under 60 seconds old is
refused with `deny` and the reason "Previous decision not verified. Call
verify_decision first."

**What "enforced" actually enforces: sequence violations, not file edits.** The
server can refuse to produce a new verdict until the last one was acknowledged.
It cannot stop a write, and it does not pretend to. A cooperating agent is
required for enforced mode to mean anything, and that limitation is the reason it
is opt-in rather than the default.

**The audit log is the ground truth.** Every decision, verification, and
suspicion is written as one JSON line, with `taskDescription` stored as a
truncated SHA-256 rather than as text. A log that quietly accumulated every
prompt would be the same kind of surprise ADR 0005 rules out, so the log is
hashed and off by default.

## Consequences

A misreported decision is now detectable and, when the audit log is enabled,
attributable. The Phase 4 failure would now produce a `fabrication_suspected`
record naming the claimed and actual decisions, which is the difference between
an argument and a fact.

The cost is a second tool and a rule for agents to follow, in exchange for
protection that only applies to agents that follow rules. The `PASS (weak)` tier
in the e2e suite exists for a related reason: a test that cannot tell "the tool
was loaded" from "the model misreported it" will eventually grade a fabrication as
a success.

Enforced mode's limit is severe enough to state plainly. An agent that never
calls `pre_action_check` is unaffected by any of this. An agent that calls it,
ignores the answer, and never verifies is likewise unaffected. What enforced mode
buys is a *sticky* sequence: once an agent has engaged with the gate, it cannot
silently skip the acknowledgement step. That is a real improvement and it is not
enforcement, and the documentation says so rather than implying otherwise.

Hard enforcement requires the agent to be configured so that the file write
itself depends on the tool result. That is agent configuration, outside this
project, and it is the only mechanism that would make a `deny` actually binding.
Noted as a Phase 6 question rather than a claim.
