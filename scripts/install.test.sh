#!/usr/bin/env bash
#
# Tests for scripts/install.sh. No bats. Only --dry-run runs, so this never
# installs anything: a test suite must not mutate the machine it runs on.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(bash "$DIR/install.sh" --dry-run 2>&1)"
STATUS=$?
fail=0

# expect <description> <extended-regex>
expect() {
  if printf '%s' "$OUT" | grep -qE "$2"; then printf 'ok   %s\n' "$1"
  else printf 'FAIL %s (missing: %s)\n' "$1" "$2"; fail=$((fail + 1)); fi
}

expect "names the package"             'gatekeeper-mcp'
expect "detects the OS"               'detected OS: (macOS|Linux)'
expect "checks the node version"      'node v[0-9]+\.[0-9]+\.[0-9]+ is supported'
expect "announces dry-run"            '\[dry-run\] no changes will be made'
expect "uses npm, not git clone"      'npm install -g --prefix .*gatekeeper-mcp'
expect "points at the installed bin"  'opencode mcp add gatekeeper -- .*/gatekeeper-mcp'
expect "hermes uses --command/--args" 'hermes mcp add gatekeeper --command .*gatekeeper-mcp'
expect "offers the npx alternative"   'npx -y gatekeeper-mcp'
expect "links the agent guides"       'docs/agents'
expect "marks codex unverified"       'Unverified'
expect "explains uninstall"           'npm uninstall -g'

if [ "$STATUS" -eq 0 ]; then printf 'ok   dry-run exits 0\n'
else printf 'FAIL dry-run exited %s, expected 0\n' "$STATUS"; fail=$((fail + 1)); fi

printf '\n'
if [ "$fail" -eq 0 ]; then printf 'all installer tests passed\n'; fi
printf '%s test(s) failed\n' "$fail"
[ "$fail" -eq 0 ]
