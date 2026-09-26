#!/usr/bin/env bash
#
# Tests for scripts/install.sh and scripts/uninstall.sh. No bats.
#
# The dry-run assertions never install anything: a test suite must not mutate the
# machine it runs on. The one exception is the round-trip below, which installs
# into a throwaway prefix under the system temp directory and removes it
# afterwards. That is the only way to prove the installer and uninstaller
# actually agree with each other, and `rm -rf` on a `mktemp -d` path is the
# narrowest version of that test available.
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

# expect_out <description> <extended-regex> <captured-output>
expect_out() {
  if printf '%s' "$3" | grep -qE "$2"; then printf 'ok   %s\n' "$1"
  else printf 'FAIL %s (missing: %s)\n' "$1" "$2"; fail=$((fail + 1)); fi
}

echo "# install.sh --dry-run"
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

echo
echo "# argument handling"
for flag in --bogus-flag --version; do
  if bash "$DIR/install.sh" "$flag" >/dev/null 2>&1; then
    printf 'FAIL install.sh accepts %s\n' "$flag"; fail=$((fail + 1))
  else
    printf 'ok   install.sh refuses %s\n' "$flag"
  fi
done
if bash "$DIR/install.sh" --help >/dev/null 2>&1; then
  printf 'ok   install.sh --help exits 0\n'
else
  printf 'FAIL install.sh --help\n'; fail=$((fail + 1))
fi
if bash "$DIR/uninstall.sh" --bogus-flag >/dev/null 2>&1; then
  printf 'FAIL uninstall.sh accepts an unknown flag\n'; fail=$((fail + 1))
else
  printf 'ok   uninstall.sh refuses an unknown flag\n'
fi

echo
echo "# uninstall.sh --dry-run"
UOUT="$(bash "$DIR/uninstall.sh" --dry-run 2>&1)"
USTATUS=$?
expect_out "announces dry-run"        '\[dry-run\] would run: npm uninstall -g' "$UOUT"
expect_out "names the prefix"         'npm uninstall -g --prefix ' "$UOUT"
expect_out "leaves agent config alone" 'Agent configuration was NOT modified' "$UOUT"
expect_out "lists where configs live"  'opencode.json' "$UOUT"
if [ "$USTATUS" -eq 0 ]; then printf 'ok   dry-run exits 0\n'
else printf 'FAIL dry-run exited %s, expected 0\n' "$USTATUS"; fail=$((fail + 1)); fi

# The round-trip. Gated on the tarball existing, because building it here would
# make this test depend on a TypeScript toolchain.
TARBALL="$(ls "$DIR"/../gatekeeper-mcp-*.tgz 2>/dev/null | head -1)"
if [ -z "$TARBALL" ]; then
  printf 'skip install/uninstall round-trip (no tarball; run `npm pack` first)\n'
else
  echo
  echo "# install -> verify -> uninstall -> verify absence -> uninstall again"
  PREFIX="$(mktemp -d)/gk-prefix"
  mkdir -p "$PREFIX"

  if npm install -g --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1; then
    printf 'ok   installs into a prefix\n'
  else
    printf 'FAIL could not install into %s\n' "$PREFIX"; fail=$((fail + 1))
  fi

  if [ -x "$PREFIX/bin/gatekeeper-mcp" ]; then printf 'ok   binary is present and executable\n'
  else printf 'FAIL binary missing at %s\n' "$PREFIX/bin/gatekeeper-mcp"; fail=$((fail + 1)); fi

  # The installer must not put anything on stdout: that stream belongs to the
  # JSON-RPC frame stream once an MCP host spawns the server.
  ROUT="$("$PREFIX/bin/gatekeeper-mcp" </dev/null 2>/dev/null)"
  if [ -z "$ROUT" ]; then printf 'ok   installed binary writes nothing to stdout\n'
  else printf 'FAIL installed binary wrote to stdout: %s\n' "$ROUT"; fail=$((fail + 1)); fi

  if npm install -g --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1 &&
     [ -x "$PREFIX/bin/gatekeeper-mcp" ]; then
    printf 'ok   re-install is idempotent\n'
  else
    printf 'FAIL re-install broke the install\n'; fail=$((fail + 1))
  fi

  if bash "$DIR/uninstall.sh" --prefix "$PREFIX" >/dev/null 2>&1; then
    printf 'ok   uninstall.sh exits 0\n'
  else
    printf 'FAIL uninstall.sh exited non-zero\n'; fail=$((fail + 1))
  fi

  if [ ! -e "$PREFIX/bin/gatekeeper-mcp" ]; then printf 'ok   binary removed\n'
  else printf 'FAIL binary still present after uninstall\n'; fail=$((fail + 1)); fi

  if [ ! -d "$PREFIX/lib/node_modules/gatekeeper-mcp" ]; then printf 'ok   package directory removed\n'
  else printf 'FAIL package directory still present\n'; fail=$((fail + 1)); fi

  # Running it again must be safe, not destructive.
  if bash "$DIR/uninstall.sh" --prefix "$PREFIX" >/dev/null 2>&1; then
    printf 'ok   second uninstall is idempotent\n'
  else
    printf 'FAIL second uninstall exited non-zero\n'; fail=$((fail + 1))
  fi

  # The uninstaller must not remove the whole prefix, only the package.
  if [ -d "$PREFIX" ]; then printf 'ok   unrelated prefix contents left alone\n'
  else printf 'FAIL uninstall removed the prefix itself\n'; fail=$((fail + 1)); fi

  rm -rf "$(dirname "$PREFIX")"
fi

printf '\n'
if [ "$fail" -eq 0 ]; then printf 'all installer tests passed\n'; fi
printf '%s test(s) failed\n' "$fail"
[ "$fail" -eq 0 ]
