# 7. The project's own verification command decides ALLOW

Date: 2026-09-27

## Status

Accepted

## Context

A pre-release security audit asked whether an untrusted coding agent could
manufacture an `allow` verdict without genuine, server-observed evidence.

The `expectFailure` inversion that made this trivially possible had already been
fixed: `reproduced` was derived from the exit code alone, and the decision engine
refused `allow` unless the evidence carried an observed non-zero exit. That fix
was necessary and correct. It was not sufficient.

Re-tested from first principles, the invariant still failed. On a clean working
tree, in a repository with no test script:

```
{"command":"false"}                        -> allow
{"command":"node","args":["-e","process.exit(1)"]} -> allow
{"command":"ls","args":["/nonexistent-xyz"]}      -> allow
{"command":"bash","args":["-c","false"]}          -> allow
```

The reason is structural. `allow` required "the agent's command exited non-zero".
The agent chooses the command. `false` is the cheapest possible way to obtain a
non-zero exit, so the condition was satisfiable at zero cost, with no bug, no
test, and no reference to the repository. The server returned `allow` with the
reason *"The reproduction failed as declared (exit code 1) and the git working
tree is clean. The change is justified."* — a confident, false assurance.

Two properties of the old design combined to produce this:

1. **"The command failed" was treated as "the reported bug was reproduced."**
   Nothing in the pipeline could tell the two apart. A typo, a wrong path, and a
   genuine bug all produce exit code 1.
2. **The contradiction check was agent-optional.** Rule 5b only ran when the
   agent passed `runTests: true`, which defaulted to `false`. The one control
   that could have cross-checked the claim was the one control the agent could
   switch off.

The combination is what defeated the gate: the agent supplied the claim, the
command that "demonstrated" it, and the decision not to have it verified.

## Options considered

**(a) Keep the contract, narrow the claim.** Document honestly that `allow` means
"a server-observed non-zero exit on a clean tree" and stop implying a bug was
found. Cheap, and truthful.

Rejected on its own. The project's thesis is that requiring evidence first makes
agents less likely to make unnecessary edits. Under (a) the evidence requirement
is satisfiable by an agent that supplies no evidence whatsoever, and the gate
emits a positive `allow` signal it cannot justify. A gate that can be bought for
one keystroke is worse than no gate, because it is believed.

**(b) Require the reproduction to name a path inside the repository.** A positive
structural check, rather than a blocklist.

Rejected. It cannot be written without either false positives or false negatives.
`npm test`, `pytest`, `go test ./...` and `cargo test --lib` name no path, so
every canonical reproduction would be refused, while `cat no-such-file.txt` names
a repository path and would pass. It also fails open on interpreters: `node -e`,
`python -c` and `bash -c` execute a program supplied as an argument, which no
argument-shape check can constrain.

**(c) Make the project's own verification surface the decisive signal, and
mandatory.** The agent's reproduction must exit non-zero, and the server must
independently run the project's verification command and observe *that* fail.

Chosen. It is the only option where the decisive signal is something the agent
does not control.

## Decision

**`allow` requires all four of the following, every one of them observed by the
server:**

1. The reproduction was executed and exited non-zero.
2. The git working tree is verified clean.
3. The project's own verification command was run by the server.
4. That verification command also failed.

Rule 5b (`tests === 'pass'`) and rule 5b' (`tests !== 'fail'`) enforce the third
and fourth clauses. Rule 5b' covers the cases where the verification surface
could not be observed at all: no test script, no runner on `PATH`, a suite that
timed out, a suite that died on a signal. All of them deny, because unknown is
not evidence and this project resolves uncertainty by refusing.

**`reproduction.runTests` is removed.** It existed only to let the agent decline
the cross-check, which is the defect. Agents that still send it are unaffected:
zod strips unknown keys rather than rejecting the call, so the field is inert and
the check still runs.

**The verification command is operator configuration, never agent input.** It is
declared as an argv array — `testCommand` — so declaring it never introduces a
shell. When unset, it is detected from the lockfile and `package.json` as before.
An agent cannot influence which command decides whether the project is broken,
which is the entire point.

**The suite runs only when it can change the verdict.** `analyze` requests it when
the evidence is `reproduced`, and `inspectState` skips it unless the tree turned
out clean, because rules 5a and 5a' settle the verdict before rule 5b is
consulted. A short-circuited call still spawns nothing.

### What this costs, stated plainly

- **A project with no discoverable verification command can never be approved.**
  This is the most significant behaviour change and it is deliberate. An operator
  whose project is not npm-based declares `testCommand: ["pytest", "-q"]`.
- **Each approval-candidate check now runs the suite once**, bounded by
  `testTimeoutMs` (default 120 s). This is real latency on a large repository and
  is the price of a decisive signal.
- **A green suite blocks approval for a genuinely new, uncovered bug.** That was
  already rule 5b's documented intent — its next steps have always said *"add a
  failing test before changing source"* — but it was advisory. It is now enforced,
  which is the correct reading of a policy the project already wrote down.

## The honest limit

`allow` means **"the project is verifiably failing, the tree is clean, and the
agent supplied a command that fails."** It does *not* mean "this particular
command demonstrates this particular bug."

An agent sitting in a genuinely broken repository can be approved with a trivial
command, because the gate cannot distinguish the two failures. This is pinned by
a test named for what it asserts, in
`tests/security/allow-invariant.test.ts`: *"documents the residual: a broken
project can be approved with a trivial command"*.

What the agent cannot do is manufacture the condition. The failing verification
command is operator-declared and server-run, so reaching `allow` requires the
repository to actually be broken. The residual is a precision limit, not a
bypass.

## Consequences

The `allow` verdict now rests on a conjunction in which only one term is
agent-supplied, and that term is the weakest one. Closing the gap between "the
project is broken" and "this is the bug you described" would require the gate to
understand the relationship between a failure and a claim, which is a semantic
problem no exit code can answer. That is a research question, not a v1.0.0 defect,
and it is recorded here so the next person does not mistake the residual for an
oversight.

Rule 5a'' is unaffected and still stands: a zero or absent exit code can never
reach `allow`, whatever the agent declares.
