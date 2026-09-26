# 2. Phase 2 makes `allow` reachable, under strict conditions

Date: 2026-09-26

## Status

Accepted

## Context

Phase 1 established the protocol surface and the fail-closed default. The
engine was stubbed: no command was ever executed, no repository was inspected,
and the decision engine returned `deny` or `request_info` on every path.
`allow` was unreachable by construction, which was the correct behaviour for a
stub and a useless behaviour for a gatekeeper.

The project had reached a state where it could refuse everything and justify
nothing. An agent integrating it in Phase 1 would have learned that calling
`pre_action_check` is a way to get told "no", and would have stopped calling it.
A gate that never opens does not prevent Action Bias; it teaches the agent to
route around the gate, at which point the agent is editing files on its own
judgement and the project provides no value at all.

Making `allow` reachable means introducing the project's first real trust
boundary. Up to Phase 1 the server's correctness was self-evident: it said no.
From here on, the server's output depends on three things it does not control:

1. **The honesty of the agent.** The agent supplies the reproduction command, so
   it chooses what gets verified. An agent that wants to edit can always supply a
   command that fails.
2. **The exit code as a proxy for "the bug exists".** A reproduction is only
   meaningful if it exercises the actual defect. `node -e "process.exit(1)"`
   fails reliably and proves nothing.
3. **Repository state at the moment of the check.** A failure observed on top of
   someone else's uncommitted work is not evidence about committed code.

We also had to decide how much evidence is enough. The tension is asymmetric:
a false `deny` costs an agent one extra round trip, while a false `allow` is the
exact failure this project exists to prevent. That asymmetry argues for a high
bar, and for resolving every ambiguity toward refusal.

Three options were considered:

1. **Keep `allow` unreachable until Phase 3.** Safest, but leaves the project
   non-functional through Phase 2 and risks the agent learning to bypass it.
2. **Allow on any non-zero exit code.** Simple, and wrong. It would approve
   changes on a dirty working tree and approve them while a green test suite
   contradicted the reproduction.
3. **Allow only on a conjunction of independent facts.** Costly to implement,
   but each fact rules out a distinct failure mode, and the conjunction cannot
   be satisfied by an agent that merely asserts failure.

We chose the third.

## Decision

`allow` is reachable through exactly one path. All three conditions must hold:

1. The reproduction was **executed** and produced the outcome the agent
   predicted: a non-zero exit under the default `expectFailure: true`, or a zero
   exit when `expectFailure: false` was declared.
2. The git working tree is **clean**, verified via `git status --porcelain`.
3. No contradiction: either tests were not requested, or they were requested and
   did not pass.

Every other combination returns `deny` or `request_info`. Free-text
`evidenceOfProblem` is explicitly **not** accepted as a substitute for an
executed command, because a paragraph of prose is exactly as easy to fabricate as
a change is to justify, and it can never be checked.

Two further choices follow from the same reasoning:

- **A clean tree is required, not merely a non-dirty tree.** A tree whose state
  could not be established is `unknown`, and `unknown` does not satisfy the
  condition. This is a deliberate narrowing of the original rule list, which
  only blocked on `dirty`; without it, a directory that is not a git repository
  at all would receive an unconditional `allow`.
- **The engine may only report, never approve, on the agent's behalf.** `allow`
  is a statement that the evidence met the bar, not a permission slip. The agent
  still chooses whether to edit. The output always states the evidence and state
  that produced the verdict so the reasoning is auditable after the fact.

The reproduction command is executed under a fixed safety model, recorded in
ADR-worthy detail in `docs/architecture.md`: `shell: false`, the working
directory confined to the repository root, stdin closed, output capped at 16 KB
per stream, and a timeout clamped to between 1 s and 300 s after which the child
is killed with `SIGKILL`.

## Consequences

The gatekeeper can now unblock a legitimate fix, which is the precondition for
anyone relying on it. An agent with a real reproduction on a clean tree gets
`allow` and proceeds, and an agent without one gets a precise instruction for
what to supply next. The tool becomes something an agent consults rather than
something it works around.

The cost is that the server now depends on the agent's honesty. It cannot
distinguish a genuine reproduction from a command engineered to fail. This is
accepted rather than solved, because the alternative is a gate that never opens.
The mitigations are all about making the honest path the easy one: the tool
description tells the agent how to supply a reproduction, `allow` requires
independent corroboration from git, and every verdict returns its evidence so a
user can audit a suspicious approval. What the project cannot do is *prove* an
agent is being truthful, and we state that plainly rather than implying
otherwise.

A second cost is that `allow` now carries real risk of a false positive, and the
failure mode is silent: a spurious approval looks identical to a correct one.
The defence is that the output always includes `evidence` and `state`, so a
reviewer can see exactly what justified an approval after the fact. That is why
those fields were added to the response rather than kept internal.

Finally, the engine now spawns processes. That is a categorically larger blast
radius than reading a string, which is why the safety model is fixed,
documented, and covered by tests rather than left to each call site, and why the
`sandboxed child process` language used in the Phase 2 plan was dropped in favour
of an honest description of what is actually enforced: no shell, a confined
working directory, closed stdin, capped output, and a hard timeout. Those
controls prevent accidental damage and trivially malformed input. They do not
constitute a security sandbox, and the project should not be described as though
it does.
