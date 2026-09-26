#!/usr/bin/env bash
#
# Verify that GATEKEEPER MCP is registered and reachable in a coding agent.
#
# Usage:
#   bash scripts/verify-agent.sh <agent-cli>
#   bash scripts/verify-agent.sh opencode
#   bash scripts/verify-agent.sh claude
#   bash scripts/verify-agent.sh codex
#   bash scripts/verify-agent.sh hermes
#
# Exit codes:
#   0  the server is registered and the agent reported it
#   1  the agent ran but the gatekeeper server is not registered
#   2  the agent could not be checked (missing CLI, no args, or no
#      non-interactive listing command)
#
# This script only ever asks an agent to LIST its MCP servers. It never starts
# an agent session and never invokes a tool on your behalf, so it is safe to run
# against a live repository.
#
# Honesty about what this proves: no agent inspected so far prints tool names in
# its non-interactive listing. They print server entries and a connection status.
# A pass here means "registered and reachable", not "the model can see
# pre_action_check". See docs/agents/VERIFICATION.md for the tool-level check.

set -euo pipefail

# Shared with the e2e scripts, so the portable macOS timeout exists once.
# shellcheck source=scripts/e2e/lib/timeout.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e/lib/timeout.sh"

# The name the server is registered under. Override if you used another.
readonly SERVER_NAME="${GATEKEEPER_SERVER_NAME:-gatekeeper}"

# The tool this project exposes, checked for when an agent does print tool names.
readonly TOOL_NAME="pre_action_check"

# Per-agent probe timeout in seconds. Generous, because a cold agent CLI can be
# slow to start.
readonly PROBE_TIMEOUT="${GATEKEEPER_PROBE_TIMEOUT:-60}"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 2
}

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/verify-agent.sh <agent-cli>

  <agent-cli>   Path to or name of the agent CLI, for example:
                  opencode, claude, codex, hermes

Environment:
  GATEKEEPER_SERVER_NAME     Server name to look for (default: gatekeeper)
  GATEKEEPER_PROBE_TIMEOUT   Per-probe timeout in seconds (default: 60)

Exit codes:
  0  server registered
  1  agent ran, server not registered
  2  agent could not be checked
EOF
}

# Runs a command with a timeout. The implementation is shared with the e2e
# scripts so there is exactly one copy of the macOS fallback logic.
run_probe() {
  run_with_timeout "$PROBE_TIMEOUT" "$@"
}

# Echoes the non-interactive command that lists MCP servers for a given agent.
#
# One branch per agent, kept deliberately small. The fallback is tried only when
# the agent is not one we know, which is what makes this usable for agents added
# after this script was written.
list_command_for() {
  local agent="$1"
  case "$agent" in
    # `opencode mcp list` prints one row per server with a connection status.
    opencode)
      printf '%s\n' "mcp list"
      ;;
    # `claude mcp list` health-checks approved servers. `get <name>` is more
    # specific but needs the server name, so `list` is the general probe.
    claude)
      printf '%s\n' "mcp list"
      ;;
    # `codex mcp list` is UNVERIFIED: codex was not available when this was
    # written. See docs/agents/codex.md. The command is still tried, because
    # probing is how a guess gets confirmed or refuted.
    codex)
      printf '%s\n' "mcp list"
      ;;
    # `hermes mcp ls` prints a table of configured servers.
    hermes)
      printf '%s\n' "mcp ls"
      ;;
    *)
      printf '%s\n' "mcp list"
      ;;
  esac
}

main() {
  if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
    usage
    fail "no agent CLI given"
  fi

  local agent_arg="$1"

  # Resolve the argument to an executable path. An argument containing a slash is
  # treated as a path directly, because `command -v` does not reliably accept an
  # absolute path in every POSIX shell.
  local agent_path=""
  case "$agent_arg" in
    */*)
      if [ -x "$agent_arg" ] && [ ! -d "$agent_arg" ]; then
        agent_path="$agent_arg"
      fi
      ;;
    *)
      if command -v "$agent_arg" >/dev/null 2>&1; then
        agent_path="$(command -v "$agent_arg")"
      fi
      ;;
  esac

  if [ -z "$agent_path" ]; then
    fail "agent CLI not found or not executable: ${agent_arg}"
  fi

  local agent_name
  # Key off the name the user invoked, not the symlink target. Several agents
  # install versioned symlinks, so `claude` can resolve to a file literally named
  # `2.1.195`, which would match no branch and hide which agent was checked.
  agent_name="$(basename "$agent_arg")"

  log "agent   : ${agent_name} (${agent_path})"
  log "server  : ${SERVER_NAME}"
  log ""

  # Probe --help first so an agent that cannot list non-interactively is reported
  # as "cannot check" rather than as "not registered". Those are very different
  # answers and conflating them is how a broken setup gets dismissed.
  local help_text=""
  if ! help_text="$(run_probe "$agent_path" --help 2>&1)"; then
    log "could not run '${agent_name} --help'; treating as uncheckable"
    fail "agent CLI did not respond to --help"
  fi

  if ! printf '%s' "$help_text" | grep -qiE '(^|[[:space:]])mcp([[:space:]]|$)'; then
    log "'${agent_name} --help' does not mention an mcp subcommand"
    fail "cannot verify: this agent exposes no non-interactive MCP listing"
  fi

  local subcommand
  subcommand="$(list_command_for "$agent_name")"

  local listing=""
  if ! listing="$(run_probe "$agent_path" $subcommand 2>&1)"; then
    log "'${agent_name} ${subcommand}' failed. Output:"
    log "${listing}"
    fail "cannot verify: the listing command did not succeed"
  fi

  log "--- ${agent_name} ${subcommand} ---"
  log "${listing}"
  log "------------------------"
  log ""

  # Best case: the agent prints tool names, which proves the tool is exposed.
  if printf '%s' "$listing" | grep -qF "$TOOL_NAME"; then
    log "PASS: found the tool '${TOOL_NAME}'."
    log "This is tool-level verification: the agent listed the tool by name."
    exit 0
  fi

  # Normal case: the agent lists servers but not tools. Still worth passing, but
  # the distinction is reported rather than hidden.
  if printf '%s' "$listing" | grep -qiF "$SERVER_NAME"; then
    log "PASS: found the server '${SERVER_NAME}'."
    log "This is registration-level verification only: '${agent_name}' does not"
    log "print tool names, so '${TOOL_NAME}' was NOT confirmed. To confirm the"
    log "tool, start a session and ask the agent to list its tools. See"
    log "docs/agents/VERIFICATION.md."
    exit 0
  fi

  log "FAIL: neither '${TOOL_NAME}' nor the server '${SERVER_NAME}' appears in"
  log "'${agent_name} ${subcommand}'."
  log ""
  log "The agent ran, so this is a real absence, not an inability to check."
  log "Register the server, then re-run. See docs/agents/<agent>.md for the"
  log "config path and copy-paste snippet."
  exit 1
}

main "$@"
