# 1. We will record architecture decisions in docs/decisions/ using lightweight ADRs

Date: 2026-09-26

## Status

Accepted

## Context

GATEKEEPER MCP is a project whose value lies almost entirely in *what it
refuses to do*: no network, no telemetry, no automatic edits, no speculative
refactors. Those constraints are invisible in the source and easy to erode. A
future contributor who finds the engine too strict, the pipeline too slow, or
the STDIO transport inconvenient will be tempted to relax the rule that
produced the change, and will have no way to discover that the rule was
deliberate rather than accidental.

The risk is highest exactly where the project is most distinctive. "Why is this
`deny` instead of a warning?" and "why does this server have no config file?"
are questions whose answers are not derivable from the code. Right now those
answers exist only in the head of whoever wrote them, which is not a durable
place.

We considered three options:

1. **No records.** Rely on code comments and commit history. Cheapest, but git
   history is rewritten by rebases, `git log` is not consulted before a
   change, and a comment cannot explain a rejected alternative.
2. **A full RFC process.** Every decision gets a proposal, a review, and a
   vote. Appropriate for a distributed team; far too heavy for a small local
   project where most decisions take minutes.
3. **Lightweight ADRs.** A short, immutable, numbered file per decision,
   written as the decision is made.

## Decision

We will record architecture decisions in `docs/decisions/` using lightweight
ADRs, numbered sequentially and never modified after acceptance.

Each ADR is a single Markdown file named `NNNN-short-slug.md` and contains
exactly three sections:

- **Context** — the forces at play, including the options considered and why
  they were rejected. Written so a reader who arrives later can reconstruct the
  situation without the original conversation.
- **Decision** — what we are doing, in the active voice: "We will ...".
- **Consequences** — what this makes easy, what it makes hard, and what we
  accept as a cost.

The rules are:

- One decision per file. A file holding two decisions will be split.
- A decision that is reversed gets a **new** ADR. The original is left
  untouched and gains a `Superseded by ADR-NNNN` line in its status. History
  is append-only.
- An ADR is written when the decision is made, not reconstructed afterwards.
  A decision with no ADR is a decision nobody made on purpose.
- Scope is architecture only: transport, protocols, data flow, dependencies,
  boundaries, and the local-only constraint. Code style, naming, and formatting
  are enforced by Biome and do not need an ADR.

## Consequences

The project carries a small, permanent record of *why* it is shaped the way it
is. A contributor considering a change that weakens a constraint can find the
ADR that established it and see the alternatives that were already rejected,
which turns "should we relax this?" into a much shorter conversation.

The cost is real but bounded. Writing an ADR takes minutes, and a project that
records everything becomes slow and bureaucratic. The mitigation is the scope
limit above: only architectural decisions are recorded, and everything else
stays a pull request. The file count stays small because most changes are not
architectural, and because an ADR is only written for decisions that would be
expensive to reverse.

Because ADRs are immutable, `docs/decisions/` grows monotonically and becomes a
reliable history rather than a document that gets rewritten to match the
current code. A reader can reconstruct not just what the system is, but the
path it took to get there.
