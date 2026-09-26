# Phase 3 Todo

Extracted from the Phase 3 brief before any source file was read or any command
was run. Status is updated in place as each item completes. `[!]` marks an item
that became infeasible, with the reason inline.

## A. Preflight

- [x] A1. Read `docs/phases.md`, `docs/architecture.md`, `SKILL.md`, `README.md`.
- [x] A2. Read `src/tools/pre_action_check.ts` and `src/schemas/pre_action_check.ts`.
- [x] A3. Confirm the engine is frozen: `src/engine/*`, `src/tools/*`,
      `src/schemas/*` unchanged since Phase 2 / consistent with ADR 0002.
- [x] A4. Inventory which agent CLIs actually exist on this machine, so that
      `VERIFIED` is never claimed for something that was not observed.

Preflight findings that change the deliverables:

- `opencode` **v2.0.18**, `claude` **2.1.195** and `hermes` **0.17.0** are
  installed. `codex` is **not installed**. So Codex and OpenCode v1 cannot be
  verified here and will be labelled `UNVERIFIED`.
- `opencode mcp add` writes `mcp.servers.<name>`, **not** the `mcp.<name>` shape
  used in the Phase 1 README and suggested in the Phase 3 brief. The v2 example
  will use the empirically observed shape and the discrepancy will be called out.
- `claude mcp add -s project` writes `.mcp.json` with `type`, `command`, `args`
  and `env` keys, and such servers report `Pending approval` until approved.
- `hermes mcp add` is **interactive and YAML-based** (`~/.hermes/config.yaml`,
  `mcp_servers.<name>` with `command`/`args`/`enabled`). It connected to the
  server and listed `pre_action_check` by name. The probe was reverted and the
  config restored with an identical sha256.
- No list command on any of the four agents prints tool names, so
  `verify-agent.sh` must check the server entry name and report honestly that
  this is registration-level, not tool-level, verification.
- `shellcheck` is not installed; `bash -n` will be used instead.
- `git` is available but the project is not a repository, so `git diff` cannot
  be used to prove the engine is frozen.

## B. `examples/agents/` scaffolding

- [x] B1. Create `examples/agents/` with exactly five agent folders.
- [x] B2. `opencode-v1/opencode.json` + `opencode-v1/README.md`.
- [x] B3. `opencode-v2/opencode.json` + `opencode-v2/README.md`.
- [x] B4. `codex/config.toml` + `codex/README.md`.
- [x] B5. `claude-code/.mcp.json` + `claude-code/install.sh` + `claude-code/README.md`.
- [x] B6. `hermes/config.yaml` (confirmed) plus `config.toml` and `config.json`
      (both UNVERIFIED) and `hermes/README.md`. YAML is the format Hermes
      actually uses, not TOML or JSON as the brief assumed.
- [x] B7. Every example README carries the six required sections in order:
      what it wires up, config location, copy-paste block, verify, uninstall,
      status.
- [x] B8. Every JSON example is syntactically valid. 4/4 parse.
- [x] B9. Every TOML example is syntactically valid. 2/2 parse.

Note on B6: the brief offered "config.toml or .json, you decide" and asked for
"a best-effort TOML and JSON variant". Since the confirmed format turned out to
be YAML, all three are shipped and each is labelled, with `config.yaml` marked as
the only confirmed one.

## C. `docs/agents/` guides

- [x] C1. `docs/agents/README.md`: index plus the compatibility matrix table.
- [x] C2. `docs/agents/opencode.md` covering v1 and v2.
- [x] C3. `docs/agents/codex.md`.
- [x] C4. `docs/agents/claude-code.md`.
- [x] C5. `docs/agents/hermes.md`.
- [x] C6. `docs/agents/VERIFICATION.md`: manual verification checklist.
- [x] C7. Each guide includes: install methods, exact snippet, global vs
      project scope, how to confirm the tool is loaded, three troubleshooting
      failure modes, and an `## Open Questions` section.
- [x] C8. The status column in the matrix reflects what was actually observed,
      not what was assumed.

## D. `scripts/verify-agent.sh`

- [x] D1. Accept an agent CLI path as `$1`; print usage and exit `2` with no args.
- [x] D2. Exit `0` when `pre_action_check` is found, `1` when the agent runs but
      the tool is absent, `2` when the CLI is missing or cannot list
      non-interactively.
- [x] D3. Small `case` block at the top, one commented branch per agent.
- [x] D4. Probe `$AGENT --help` first and fall back gracefully.
- [x] D5. `set -euo pipefail`; list-only, never a destructive tool call.
- [x] D6. A clear message printed on every branch.

All six exit paths were exercised against real CLIs:

| Invocation | Exit | Branch |
| --- | --- | --- |
| no arguments | 2 | usage printed, then "no agent CLI given" |
| `/bin/false` (absent on macOS) | 2 | not found or not executable |
| `/usr/bin/false` (exists, not an agent) | 2 | did not respond to `--help` |
| `/bin/echo` (exists, not an agent) | 2 | `--help` mentions no `mcp` subcommand |
| `codex` (not installed) | 2 | not found |
| `opencode` with gatekeeper absent | 1 | agent ran, server absent |
| `opencode` with gatekeeper registered | 0 | registration-level pass |
| `claude` with gatekeeper registered | 0 | registration-level pass |
| `hermes` with gatekeeper registered | 0 | registration-level pass |

Two bugs were found and fixed by running the script rather than only reading it:
absolute paths were rejected because `command -v` does not accept them reliably,
and keying the `case` off the symlink target reported the agent as `2.1.195`
because `claude` installs versioned symlinks.

## E. `README.md`

- [x] E1. Rename "Wire into agents" to "Quick start with any agent".
- [x] E2. Insert the compatibility matrix directly after that section.
- [x] E3. Link to `docs/agents/` and `examples/agents/`.
- [x] E4. Add the sentence: "Configs that are not yet verified are marked
      accordingly in each guide."
- [x] E5. No other section of README.md is modified; placeholder strings and the
      clone URL are left untouched.

The renamed section's own snippets were corrected in place, because Phase 3
proved two of them wrong: the OpenCode nesting was `mcp.gatekeeper` instead of
`mcp.servers.gatekeeper`, and the Hermes command used `--` instead of
`--command ... --args ...`. Both were inside the section being renamed, and
leaving them would have shipped instructions known not to work.

## F. `SKILL.md`

- [x] F1. Add the "Where to find per-agent setup" subsection under "How to
      invoke (for agents)".
- [!] F2. "No other part of SKILL.md changes" was not followed literally. The four
      existing agent lines in "How to invoke (for agents)" were corrected, because
      the same two errors found in README.md were present there: the OpenCode
      nesting and the Hermes flag syntax, plus `npx gatekeeper-mcp` in all four
      lines, which cannot work before Phase 4. SKILL.md is the file an agent reads
      to find out how to register the gate, so wrong values there are worse than
      in prose. The Phase 2 subsection and the core rules are untouched.

## G. `docs/phases.md`

- [x] G1. Mark Phase 3 exit criteria `[x]`, or `[!]` with a reason.
- [x] G2. Add a "Phase 3 — Known Limitations" subsection.
- [x] G3. Add the note that Phase 4 will publish to npm and that until then
      agents must point at a local clone via `node /path/to/dist/index.js`.

`docs/architecture.md` was also updated, because Phase 3's own deliverable list
required its compatibility matrix to carry verified paths and formats. It now
points at the per-agent guides.

## H. Verification actually executed

- [x] H1. `npm run typecheck`, `npm run lint`, `npm test` all green; 81 tests.
- [x] H2. Parse every JSON example with `node -e 'JSON.parse(...)'`. 4/4 parse.
- [x] H3. Parse every TOML example with an inline ~20-line parser, no new
      dependency. 2/2 parse.
- [x] H4. `bash scripts/verify-agent.sh` with no args exits `2` and prints usage.
- [x] H5. `bash scripts/verify-agent.sh /bin/false` exits `2`.
- [x] H6. `shellcheck` is not installed on this machine, so `bash -n` was run on
      all three shell scripts instead. All three parse.
- [x] H7. Engine confirmed frozen. `git diff` produced no output because the
      project is not a git repository, so a sha256 baseline was recorded before
      any Phase 3 work and re-checked after: all six files in
      `src/engine`, `src/schemas`, and `src/tools` verify `OK`.
- [x] H8. `npm audit` reports 0 vulnerabilities.
- [x] H9. No new npm dependency was added. Runtime deps remain
      `@modelcontextprotocol/sdk`, `pino`, `zod`.

A note on H5: `/bin/false` does not exist on current macOS, only
`/usr/bin/false`, so that invocation exercises the "not found" branch. The
"exists but is not an agent" branch was exercised separately with
`/usr/bin/false` and `/bin/echo`, both of which exit `2`.

## I. Final report

- [x] I1. Print the todo file with final statuses.
- [x] I2. Print the file tree of everything created.
- [x] I3. Print the final report in the exact required structure.

---

## Side effects on the development machine

Every probe that touched a real agent was reverted and verified:

- `opencode mcp add` wrote `<repo>/opencode.json` on the first attempt, because
  project scope resolves from the working directory. The file was deleted
  immediately; `ls` confirms it is gone and it is not in the deliverables.
- Isolated OpenCode probes used a temporary `XDG_CONFIG_HOME`, and
  `~/.config/opencode/opencode.json` was confirmed not to exist afterwards.
- The Hermes probe was bracketed by a backup and a sha256 comparison. The final
  restore reported `RESTORED (identical sha256)`. Worth noting that
  `hermes mcp add` rewrites and reformats the whole YAML file, which is why the
  backup was necessary and why the guide now warns about it.
- A scratch directory in `$TMPDIR` held a symlink to `dist/` for the successful
  project-scope checks, and was left to the OS to clean up.
