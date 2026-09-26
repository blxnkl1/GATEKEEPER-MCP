# 5. GATEKEEPER MCP stays free and local, permanently

Date: 2026-09-26

## Status

Accepted

## Context

The project's pitch rests on a promise: GATEKEEPER MCP runs on your machine, for
free, and talks to nothing. That promise is currently a description, not a
constraint. Nothing in the repository prevents a future change from quietly
breaking it, and the failure would be quiet.

Consider how each promise could be broken by an innocent-seeming change:

- **A telemetry line.** "It would be useful to know how often the gate denies."
  One `fetch` call to an analytics endpoint. Users would have no way to notice
  except by reading the source, and the README would still say the project is
  local.
- **An API key requirement.** "The decision policy is much better with a hosted
  model." GATEKEEPER would go from a tool anyone can run to a service, and the
  free tier would become the product's distribution channel.
- **A paid dependency.** A hosted sandbox for running reproduction commands would
  solve a real problem, and it would also mean a network call, a cost, and a
  vendor. The reproduction runner is currently the largest blast radius in the
  codebase, so this is the likeliest place for the temptation to appear.
- **A hosted mode.** "Cloud agents need a hosted gatekeeper." A single extra
  transport, HTTP this time, changes the threat model completely: the project
  currently trusts its caller because the caller is the local user.

The cost of the promise being real is that some genuinely useful features become
impossible. There will come a day when hosted sandboxes or shared policy caches
are the right answer, and this ADR says no to that day in advance. That is the
point of writing it down: a future contributor who hits that wall can read this
and see the decision was deliberate, rather than concluding nobody considered it.

There is also a self-interest worth naming. A gatekeeper whose author profits from
running it has a different relationship to a `deny` than one whose author gets
nothing either way. The promise is not only about user trust, it is about whether
this tool can be trusted to say no.

## Decision

GATEKEEPER MCP will:

1. **Never send telemetry or phone home.** No usage analytics, no crash
   reporting, no update pings, no error reporting. Nothing leaves the machine.
2. **Never require an API key, an account, or a network call to function.** Every
   feature works offline. If a feature cannot work offline, it does not ship.
3. **Keep all runtime dependencies free and open source**, under MIT, Apache-2.0,
   BSD-2-Clause, BSD-3-Clause, or ISC. A dependency whose licence forbids
   commercial use, or that is source-available rather than open source, is not
   acceptable.
4. **Never introduce a paid tier, a cloud-hosted mode, a usage limit, or a
   licence key.** There is no paid version of this project, ever, including for
   its author.
5. **Remain MIT licensed permanently.**

The two existing runtime dependencies, `@modelcontextprotocol/sdk` and `zod`, are
MIT. `pino` is MIT. All three satisfy rule 3 today.

## Consequences

Any pull request that adds a network call, a paid or non-OSI dependency, or a
hosted component must be rejected, or must explicitly overturn this ADR with a
new one. The burden of proof sits with the change, not with the status quo, and
overturning it requires writing down why a promise made in public should be
broken. That is the mechanism: not a rule that cannot be broken, but one that
cannot be broken quietly.

The project gains a property that is hard to retrofit. There is no account to
lose, no vendor to discontinue, and no service to shut down, so the tool keeps
working for anyone who has it. In exchange, there is no revenue path, and no
hosted feature set. For a tool whose entire value is telling users *no*, that
trade is the right one: the incentive to loosen a denial has to be zero, and the
simplest way to guarantee that is to have nothing to gain from loosening it.

Two things this ADR does not do. It does not make the project auditable on its
own; "we promise not to phone home" is not a technical control, and
`docs/architecture.md` remains the place a reader looks for the design. And it
does not settle the open question from ADR 0004, that a model can report a tool
result it never received. That is a correctness problem, not a business one, and
it is not resolved by any of the five rules above.
