# Changelog

All notable changes to GATEKEEPER MCP are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-27

First public release. Two tools, a deterministic decision policy, and a security
model whose limits are documented rather than implied.

### Security

- **`ALLOW` can no longer be manufactured from a trivial failure.** The gate now
  requires, in addition to a non-zero exit and a clean tree, that the server runs
  the project's own verification command and observes *that* fail. Previously
  `{"command":"false"}` on a clean tree returned `allow`, because the agent chose
  the command and the one cross-check was opt-out. See
  [ADR 0007](docs/decisions/0007-verification-command-decides-allow.md).
- **Removed `reproduction.runTests`.** It existed only to let the agent decline
  the cross-check. Agents still sending it are unaffected: the field is ignored,
  not rejected.
- **A zero or absent exit code can never reach `ALLOW`** (`decide` rule `5a''`),
  enforced at the point where permission is granted rather than only where the
  evidence is classified.
- **`reproduction.expectFailure` is descriptive metadata only.** It records what
  the agent expected and is echoed in the detail string; it is never consulted
  when classifying the outcome. It previously inverted the result, so
  `{"command":"true","expectFailure":false}` produced `reproduced` and reached
  `allow`. See [ADR 0002](docs/decisions/0002-phase-2-decision-policy.md).
- **Shells, script hosts and network fetchers are on the default denylist.**
  `bash -c "…"` is a shell by another name, so allowing it while refusing
  `curl … | sh` made the pattern denylist decorative.
- **The `cwd` sandbox resolves symlinks.** Both sides go through `realpath`, so a
  committed symlink aimed outside the repository is refused. The previous
  comparison was lexical and the child really did run over there.
- **Denylist rejections are auditable.** The advertised MCP schema deliberately
  omits the denylist, because the SDK validates arguments before the tool handler
  runs and a rejection at that layer produced no `denylist_rejected` event. Every
  rejection is now both explained to the agent and recorded.
- **`verify_decision` has its own request budget.** It was the one
  security-relevant call with no limit. The budget is separate from the
  pre-action one so enforced mode can always verify between two checks.
- **Invalid configuration still fails closed**, with exit code 78 and nothing on
  stdout. No configuration option can switch the invariant off.
- **`npm pack` now builds first.** A `prepack` script was added after a release
  audit found that `npm pack` in a clean checkout produced a five-file package
  containing no server at all: `dist/` is gitignored, `prepublishOnly` is a
  publish-only hook that `npm pack` does not run, and the `files` allowlist
  silently matched nothing. Anyone installing from a git URL, or packing
  locally, would have received a broken package.

### Added

- `verify_decision`, the second tool. Every `pre_action_check` reply carries a
  CSPRNG nonce; presenting it with the decision you intend to report checks the
  claim against what the server issued, and a contradiction is recorded as
  `fabrication_suspected`. Advisory by default, `enforced` opt-in. See
  [ADR 0006](docs/decisions/0006-anti-fabrication-strategy.md).
- Layered configuration via `$GATEKEEPER_CONFIG`, `.gatekeeperrc.json`, or
  `~/.gatekeeperrc.json`: `mode`, `rateLimit`, `denylist`, `auditLog`,
  `nonceStore`, `testCommand`, `testTimeoutMs`.
- `testCommand`, an operator-declared verification command as an argv array, so
  non-npm projects can supply one and declaring it never introduces a shell.
- Append-only local audit log with single-generation rotation at 10 MB, storing
  `taskDescription` as a truncated SHA-256 rather than as text.
- Sliding-window rate limiting, with rejected requests counted.
- Bounded single-use nonce store: 16 CSPRNG bytes, base64url, capped at 1000
  entries with a 5-minute TTL.
- `scripts/e2e/mcp-protocol.sh`, a deterministic stdio protocol test that needs
  no model, no key and no network, and runs on every CI commit.
- `scripts/uninstall.sh` and `scripts/install.test.sh`.
- CI and tag-triggered npm release workflows, with provenance.
- Black-box `tests/security/` suite asserting the ALLOW invariant through a real
  MCP client, and `tests/guarantees/` asserting the local-only promises
  mechanically.

### Changed

- The decision policy now has six ordered rules. Rules `5a''`, `5b` and `5b'`
  are new or unconditional; see
  [architecture](docs/architecture.md#decision-order).
- The verification command runs only when it can change the verdict, so a
  short-circuited call still spawns nothing.
- Documentation states what the server constrains and what it does not, in an
  [Execution Boundary](docs/architecture.md#execution-boundary) section, rather
  than implying a sandbox.

### Known limitations

These are properties of the architecture, documented rather than hidden. They are
not defects to be fixed in a patch release.

- **MCP cannot block a file edit.** A `deny` is advice. Enforcement is limited to
  refusing to issue a new verdict while the previous one is unverified. Making a
  `deny` binding requires gating the agent's write tool on the check result, which
  is agent configuration outside this project.
- **A project with no discoverable verification command can never be approved.**
  The gate refuses when it cannot cross-check a claim. Declare `testCommand`.
- **`allow` does not confirm that your command demonstrates your bug.** It means
  the project is verifiably failing and the tree is clean. The agent cannot
  manufacture that condition, but the gate cannot distinguish which failure is
  which. Pinned by a test named for what it asserts.
- **Only the working directory is confined.** `args` are passed through verbatim,
  so a permitted command can read any file the user can read. GATEKEEPER is not a
  filesystem sandbox.
- **Only the direct child is killed on timeout.** A reproduction that daemonises
  can outlive the call.
- **GATEKEEPER itself performs no network egress; reproduction commands may.**
  Fetchers are denylisted to discourage it, not to prevent it.
- **Agent compliance is unmeasured.** The OpenCode and Freebuff benchmarks could
  not be completed in the release environment: OpenCode's provider returned
  HTTP 403 for any MCP tool call routed through its code-execution tool, and
  Freebuff could not reach its backend. Both are external failures, reproduced
  with a control. No compliance result is claimed.

[1.0.0]: https://github.com/blxnkl1/GATEKEEPER-MCP/releases/tag/v1.0.0
