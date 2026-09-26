#!/usr/bin/env bash
#
# GATEKEEPER MCP - protocol test. No LLM involved.
# Copyright (c) 2026 blxnkl1
# SPDX-License-Identifier: MIT
#
# Proves the MCP server itself works: it starts, speaks JSON-RPC over stdio,
# advertises pre_action_check, and denies a change that carries no evidence.
#
# This test is deterministic and free. It needs no API key, no model, no
# network, and no agent, so it can run in CI on every commit. Anything it does
# not cover is about agent behaviour, which belongs in agent-integration.sh.
#
# Usage: bash scripts/e2e/mcp-protocol.sh
# Exit:  0 PASS, 1 FAIL

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=scripts/e2e/lib/timeout.sh
. "${SCRIPT_DIR}/lib/timeout.sh"

readonly PROTOCOL_TIMEOUT_SECS=30

info() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

build_if_needed() {
  if [ -f "${REPO_ROOT}/dist/index.js" ]; then
    info "build: using existing dist/index.js"
    return 0
  fi
  info "build: dist/index.js missing, building"
  if ! ( cd "$REPO_ROOT" && npm run build ); then
    fail "build failed"
  fi
  [ -f "${REPO_ROOT}/dist/index.js" ] || fail "build did not produce dist/index.js"
}

main() {
  info "GATEKEEPER MCP protocol test (no LLM)"
  info ""

  command -v node >/dev/null 2>&1 || fail "node is not on PATH"
  command -v npm >/dev/null 2>&1 || fail "npm is not on PATH"

  build_if_needed
  info ""

  local output rc=0
  # The client has its own internal deadlines; the external timeout is the
  # backstop for a server that wedges before it can even answer initialize.
  output="$(run_with_timeout "$PROTOCOL_TIMEOUT_SECS" \
    node "${SCRIPT_DIR}/protocol-client.mjs" "${REPO_ROOT}/dist/index.js" 2>&1)" || rc=$?

  if [ "$rc" -eq 124 ]; then
    info "FAIL: protocol test exceeded ${PROTOCOL_TIMEOUT_SECS}s"
    exit 1
  fi

  if [ "$rc" -ne 0 ]; then
    info "--- client output ---"
    printf '%s\n' "$output"
    info "---------------------"
    info ""
    info "FAIL: protocol test failed (exit ${rc})"
    exit 1
  fi

  # Print each check so a failure names itself rather than just "test failed".
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$output" | node -e '
      let s = ""
      process.stdin.on("data", (d) => { s += d })
      process.stdin.on("end", () => {
        const start = s.indexOf("{")
        if (start === -1) { console.log(s); return }
        let parsed
        try { parsed = JSON.parse(s.slice(start)) } catch { console.log(s); return }
        for (const c of parsed.checks) {
          const mark = c.ok ? "ok  " : "FAIL"
          const detail = c.detail ? `  (${c.detail})` : ""
          console.log(`${mark} ${c.name}${detail}`)
        }
      })
    '
  else
    printf '%s\n' "$output"
  fi

  info ""
  if printf '%s' "$output" | grep -q '"passed": true'; then
    info "PASS: the server speaks MCP correctly and denies unevidenced changes"
    exit 0
  fi

  info "FAIL: the client did not report an overall pass"
  exit 1
}

main "$@"
