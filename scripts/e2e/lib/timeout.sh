#!/usr/bin/env bash
#
# GATEKEEPER MCP - portable timeout helper.
# Copyright (c) 2026 blxnkl1
# SPDX-License-Identifier: MIT
#
# Sourced by the e2e scripts. Do not duplicate the function elsewhere.
#
# Why this exists: an agent CLI in --print mode can block indefinitely. In
# Claude Code's case it waits for a human to approve a newly registered MCP tool,
# and in a script there is no human, so it simply never returns. Without a
# timeout that turns a test suite into a hang.

# run_with_timeout <seconds> <command...>
#
# Runs the command, allowing it at most <seconds>. Returns the command's own
# exit status, or 124 if it was killed for running too long. 124 is the
# conventional status used by GNU timeout, so callers can treat it as "unknown".
#
# Collapses every "killed for taking too long" status to 124.
#
# 143 is 128 + SIGTERM and 137 is 128 + SIGKILL. GNU timeout reports 137 when it
# has to escalate to SIGKILL, while the portable fallback reports 143 or 137
# depending on which signal landed. Callers should not have to care which
# implementation ran, so all of them become 124.
normalize_timeout_status() {
  case "$1" in
    124 | 137 | 143) return 124 ;;
    *) return "$1" ;;
  esac
}

# Every branch escalates: SIGTERM first, so the child gets a chance to clean up,
# then SIGKILL after a grace period. A child that ignores SIGTERM would otherwise
# defeat the whole point of a timeout, and that is not hypothetical.
run_with_timeout() {
  local secs="$1"
  shift
  local grace="${TIMEOUT_KILL_GRACE:-5}"

  # --kill-after is not optional. GNU timeout sends only SIGTERM by default, so a
  # child that ignores or blocks SIGTERM runs to completion and the timeout does
  # nothing. That was observed here with a real command, not theorised.
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after="$grace" "$secs" "$@"
    normalize_timeout_status $?
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after="$grace" "$secs" "$@"
    normalize_timeout_status $?
    return $?
  fi

  # No GNU coreutils, which is the default on stock macOS.
  "$@" &
  local pid=$!

  (
    sleep "$secs"
    kill -TERM "$pid" 2>/dev/null
    sleep "$grace"
    kill -KILL "$pid" 2>/dev/null
  ) &
  local watcher=$!

  wait "$pid" 2>/dev/null
  local rc=$?

  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null

  # 143 = 128 + SIGTERM, 137 = 128 + SIGKILL. Either means the timeout fired.
  normalize_timeout_status "$rc"
  return $?
}
