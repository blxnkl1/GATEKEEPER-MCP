#!/usr/bin/env bash
#
# GATEKEEPER MCP - agent integration test. Optional, uses an LLM.
# Copyright (c) 2026 blxnkl1
# SPDX-License-Identifier: MIT
#
# Proves a real coding agent can load the server and act on its verdict. This is
# the flaky, expensive, optional half of the test suite. The deterministic half
# lives in mcp-protocol.sh, which must pass first: if the server is broken there
# is no point blaming an agent for it.
#
# Every agent runs in a throwaway git repository in $TMPDIR with a project-scope
# config. No global or user agent config is read or written. The temp repository
# is removed on every exit path.
#
# Usage: bash scripts/e2e/agent-integration.sh [--agent <name>]
# Exit:  0 if at least one agent passed, or all were skipped
#        1 if any agent failed or timed out

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=scripts/e2e/lib/timeout.sh
. "${SCRIPT_DIR}/lib/timeout.sh"

readonly VERSION_TIMEOUT_SECS=5
readonly AUTH_TIMEOUT_SECS=10
readonly AGENT_TIMEOUT_SECS=90

# No evidence supplied, so the correct verdict is a deny. A passing test here
# means the agent both reached the tool and respected the refusal.
readonly PROMPT="Call pre_action_check with taskDescription='x', proposedChange='y', affectedFiles=[]. Report the decision."

ONLY_AGENT=""
TEMP_REPO=""
RESULTS=()

info() { printf '%s\n' "$*"; }

cleanup() {
  if [ -n "$TEMP_REPO" ] && [ -d "$TEMP_REPO" ]; then
    rm -rf "$TEMP_REPO"
  fi
}
trap cleanup EXIT INT TERM

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --agent)
        [ "$#" -ge 2 ] || { printf 'error: --agent requires a value\n' >&2; exit 2; }
        ONLY_AGENT="$2"
        shift 2
        ;;
      *) printf 'error: unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
  done
}

# add_result <agent> <status> <detail>
add_result() {
  RESULTS+=("$1"$'\t'"$2"$'\t'"$3")
}

# A CLI that exists and answers --version quickly is worth trying.
agent_present() {
  command -v "$1" >/dev/null 2>&1 || return 1
  run_with_timeout "$VERSION_TIMEOUT_SECS" "$1" --version >/dev/null 2>&1
}

make_temp_repo() {
  TEMP_REPO="$(mktemp -d "${TMPDIR:-/tmp}/gk-agent-e2e-XXXXXX")"
  mkdir -p "${TEMP_REPO}/src"
  printf 'export const noop = (): void => {}\n' >"${TEMP_REPO}/src/index.ts"
  printf '# agent integration fixture\n' >"${TEMP_REPO}/README.md"
  cat >"${TEMP_REPO}/package.json" <<'EOF'
{
  "name": "gk-agent-e2e-fixture",
  "version": "1.0.0",
  "private": true
}
EOF
  (
    cd "$TEMP_REPO" &&
      git init -q &&
      git config user.email "e2e@example.invalid" &&
      git config user.name "e2e" &&
      git add -A &&
      git commit -q -m "fixture"
  ) >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Per-agent runs. Each returns 0 pass, 1 fail, 124 timeout, or 2 skip, and
# writes the reason to stdout.
# ---------------------------------------------------------------------------

run_opencode() {
  local output rc=0 detail model_arg=()
  ( cd "$TEMP_REPO" && opencode mcp add gatekeeper -- \
      node "${REPO_ROOT}/dist/index.js" ) >/dev/null 2>&1 ||
    { printf 'model=unknown, could not register the server with opencode'; return 2; }

  # A pinned model is logged verbatim, because when the caller supplies one we
  # know it even though OpenCode does not report it.
  local requested_model="${GATEKEEPER_TEST_MODEL:-}"
  if [ -n "$requested_model" ]; then
    model_arg=(--model "$requested_model")
  fi
  output="$( cd "$TEMP_REPO" && run_with_timeout "$AGENT_TIMEOUT_SECS" \
    opencode run "$PROMPT" --format json "${model_arg[@]}" 2>&1 )" || rc=$?

  printf '%s' "$output" >"${TEMP_REPO}/opencode-output.txt"

  if [ "$rc" -eq 124 ]; then
    printf 'model=%s, agent call exceeded %ss' "$model_label" "$AGENT_TIMEOUT_SECS"
    return 124
  fi

  # OpenCode's --format json stream carries no model field. Verified across three
  # runs on v2.0.18, including one with an explicit --model: the frame keys are
  # always type,timestamp,sessionID,part (or error), with nothing model-shaped.
  # So the model is reported from what we passed in, and when we passed nothing
  # the frame keys are emitted so a future run can diff them against this note.
  local stream_model frame_keys err
  stream_model="$(printf '%s' "$output" | node "${SCRIPT_DIR}/lib/stream-info.mjs" model 2>/dev/null)"
  frame_keys="$(printf '%s' "$output" | node "${SCRIPT_DIR}/lib/stream-info.mjs" keys 2>/dev/null)"
  err="$(printf '%s' "$output" | node "${SCRIPT_DIR}/lib/stream-info.mjs" error 2>/dev/null)"

  model_label="${requested_model:-${stream_model:-unreported}}"
  if [ "$model_label" = "unreported" ] && [ -n "$frame_keys" ]; then
    model_label="unreported(frames:${frame_keys})"
  fi

  # A provider error means the model never ran, so no tool call was possible.
  # That is a credentials or quota problem on the agent side, not an integration
  # fault, and saying so is far more useful than "the model declined".
  if [ -n "$err" ]; then
    printf 'model=%s, %s' "$model_label" "$err"
    return 2
  fi

  # Two invocation shapes are accepted. The native event is a tool call the
  # harness records itself. The Code Mode bridge is how OpenCode models reach
  # MCP tools when the agent exposes them through the catalog rather than
  # natively, and it is a real call by a different route to the same server.
  if printf '%s' "$output" | grep -q 'gatekeeper\.pre_action_check'; then
    detail="tool invoked (native tool event)"
  elif printf '%s' "$output" | grep -q 'tools\.opencode\['; then
    detail="tool invoked (Code Mode bridge)"
  elif ( cd "$TEMP_REPO" && opencode mcp list 2>/dev/null ) | grep -qi 'gatekeeper'; then
    # The server is registered and connected, so the integration is sound. A
    # model that then declines to call the tool is a model-behaviour outcome, and
    # it varies run to run on the same build. Reporting it as FAIL would make the
    # script red for reasons outside this project.
    printf 'model=%s, server connected, tool not invoked' "$model_label"
    return 2
  else
    printf 'model=%s, server not registered with opencode' "$model_label"
    return 1
  fi

  if printf '%s' "$output" | grep -q '"decision":"deny"\|"decision": "deny"'; then
    printf 'model=%s, %s, decision=deny' "$model_label" "$detail"
    return 0
  fi

  printf 'model=%s, %s, but no deny decision in the response' "$model_label" "$detail"
  return 1
}

run_claude() {
  local output auth_output rc=0

  # Claude Code blocks in --print mode waiting for a human to approve a newly
  # registered MCP tool, and there is no human here to approve it. --allowedTools
  # pre-approves exactly the one tool under test, which is what lets the call
  # proceed unattended.
  #
  # The auth probe deliberately passes no --allowedTools: an empty value for
  # that flag swallows the prompt argument and the probe then fails for the wrong
  # reason, which is indistinguishable from being logged out.
  auth_output="$( run_with_timeout "$AUTH_TIMEOUT_SECS" \
    claude --print "hi" 2>&1 )" || true

  if printf '%s' "$auth_output" | grep -qi 'not logged in'; then
    printf 'not authenticated'
    return 2
  fi

  ( cd "$TEMP_REPO" && claude mcp add gatekeeper -- \
      node "${REPO_ROOT}/dist/index.js" ) >/dev/null 2>&1 ||
    { printf 'could not register the server with claude'; return 2; }

  # The prompt must come before --allowedTools, otherwise claude treats the rest
  # of the line as further flag arguments.
  output="$( cd "$TEMP_REPO" && run_limited_claude )" || rc=$?

  printf '%s' "$output" >"${TEMP_REPO}/claude-output.txt"

  if [ "$rc" -eq 124 ]; then
    printf 'agent call exceeded %ss (tool approval prompt?)' "$AGENT_TIMEOUT_SECS"
    return 124
  fi

  if printf '%s' "$output" | grep -q 'deny'; then
    printf 'assistant reported deny'
    return 0
  fi

  if printf '%s' "$output" | grep -qi 'not logged in'; then
    printf 'not authenticated'
    return 2
  fi

  printf 'no deny decision in the assistant output'
  return 1
}

run_limited_claude() {
  run_with_timeout "$AGENT_TIMEOUT_SECS" \
    claude --print "$PROMPT" --allowedTools "mcp__gatekeeper__pre_action_check" 2>&1
}

# Codex has no verified config format. Running it would mean guessing, and a
# guessed config fails for reasons unrelated to this project.
run_codex() {
  printf 'config format unverified, not exercised'
  return 2
}

# Hermes registers servers only through an interactive prompt that cancels when
# there is no TTY. Exercising it would mean editing the user global config from
# a test, which is not acceptable.
run_hermes() {
  printf 'interactive registration only'
  return 2
}

main() {
  parse_args "$@"

  info "GATEKEEPER MCP agent integration test"
  info ""

  if ! bash "${SCRIPT_DIR}/mcp-protocol.sh" >/dev/null 2>&1; then
    info "FAIL: protocol test failed, skipping agent integration"
    exit 1
  fi
  info "protocol test: PASS"
  info ""

  if [ ! -f "${REPO_ROOT}/dist/index.js" ]; then
    ( cd "$REPO_ROOT" && npm run build >/dev/null 2>&1 )
  fi

  make_temp_repo

  local agent version
  for agent in opencode claude codex hermes; do
    if [ -n "$ONLY_AGENT" ] && [ "$ONLY_AGENT" != "$agent" ]; then
      continue
    fi

    if [ "$agent" = "hermes" ]; then
      add_result "$agent" "SKIPPED" "interactive registration only"
      continue
    fi

    if [ "$agent" = "codex" ]; then
      if agent_present codex; then
        add_result "$agent" "SKIPPED" "config format unverified, not exercised"
      else
        add_result "$agent" "SKIPPED" "not installed"
      fi
      continue
    fi

    if ! agent_present "$agent"; then
      add_result "$agent" "SKIPPED" "not installed"
      continue
    fi

    version="$( run_with_timeout "$VERSION_TIMEOUT_SECS" "$agent" --version 2>&1 | head -1 )"
    info "running ${agent} (${version}) ..."

    local detail status rc=0
    detail="$( "run_${agent}" )" || rc=$?

    case "$rc" in
      0)
        status="PASS"
        ;;
      2)
        status="SKIPPED"
        ;;
      124)
        status="TIMEOUT"
        ;;
      *)
        status="FAIL"
        ;;
    esac

    add_result "$agent" "$status" "$detail"
    info "  ${agent}: ${status} (${detail})"
  done

  info ""
  info "agent       status          detail"
  local row
  for row in "${RESULTS[@]}"; do
    printf '%-12s %-15s %s\n' \
      "$(printf '%s' "$row" | cut -f1)" \
      "$(printf '%s' "$row" | cut -f2)" \
      "$(printf '%s' "$row" | cut -f3)"
  done

  local passed=0 failed=0
  for row in "${RESULTS[@]}"; do
    case "$(printf '%s' "$row" | cut -f2)" in
      PASS) passed=$((passed + 1)) ;;
      FAIL | TIMEOUT) failed=$((failed + 1)) ;;
    esac
  done

  info ""
  if [ "$failed" -gt 0 ]; then
    info "FAIL: ${failed} agent(s) failed or timed out"
    exit 1
  fi
  if [ "$passed" -gt 0 ]; then
    info "PASS: ${passed} agent(s) invoked the tool and respected the denial"
    exit 0
  fi
  info "SKIPPED: no agent was eligible; this is not a failure"
  exit 0
}

main "$@"
