#!/usr/bin/env bash
#
# GATEKEEPER MCP - uninstaller
# Copyright (c) 2026 blxnkl1
# SPDX-License-Identifier: MIT
#
# Removes the globally installed GATEKEEPER MCP package.
#
# This script deliberately does NOT touch any agent configuration. Agent configs
# are hand-maintained files that may have been edited, may be shared with a team
# through version control, and may list other MCP servers. Deleting or rewriting
# them automatically is far more destructive than leaving a stale entry behind,
# so this script prints where they are and leaves the decision to you.
#
# Usage:
#   bash uninstall.sh [options]
#
# Options:
#   --prefix <dir>   Prefix the package was installed into. Default: $HOME/.local
#   --dry-run        Print what would happen, then exit without changing anything.
#   -h, --help       Show this help.

set -euo pipefail

readonly PACKAGE_NAME="gatekeeper-mcp"
readonly REPO_URL="https://github.com/blxnkl1/GATEKEEPER-MCP"

PREFIX="${HOME}/.local"
DRY_RUN="false"

info() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --prefix)
        [ "$#" -ge 2 ] || fail "--prefix requires a value"
        PREFIX="$2"
        shift 2
        ;;
      --prefix=*)
        PREFIX="${1#*=}"
        shift
        ;;
      --dry-run)
        DRY_RUN="true"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        fail "unknown option: $1 (try --help)"
        ;;
    esac
  done
}

check_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    fail "npm was not found, so the package cannot be removed automatically. Remove it from ${PREFIX} by hand, or install Node.js and re-run."
  fi
}

uninstall_package() {
  if [ "$DRY_RUN" = "true" ]; then
    info "[dry-run] would run: npm uninstall -g --prefix ${PREFIX} ${PACKAGE_NAME}"
    return 0
  fi

  info "removing ${PACKAGE_NAME} from ${PREFIX}"
  if npm uninstall -g --prefix "$PREFIX" "$PACKAGE_NAME"; then
    info "removed ${PACKAGE_NAME}"
  else
    fail "npm uninstall failed. If the package was installed with a different prefix, pass it: bash uninstall.sh --prefix <dir>"
  fi
}

# The package is gone, but every agent still has a config entry pointing at a
# binary that no longer exists. Report where those entries live so the user can
# decide what to do rather than leaving them to discover a broken tool later.
print_agent_config_locations() {
  cat <<EOF

Agent configuration was NOT modified. These files may still reference
${PACKAGE_NAME}, and a stale entry makes an agent show the server as failed:

  OpenCode      <project>/opencode.json
                ~/.config/opencode/opencode.json
  Claude Code   <project>/.mcp.json
                ~/.claude.json
  Hermes Agent  ~/.hermes/config.yaml
  Codex         ~/.codex/config.toml

Remove the entry for the server named "gatekeeper". Per-agent instructions:
  ${REPO_URL}/tree/main/docs/agents

To confirm the package is gone:
  opencode mcp list      # or: claude mcp list   /   hermes mcp list
EOF
}

main() {
  parse_args "$@"

  info "GATEKEEPER MCP uninstaller"
  info ""

  check_npm
  uninstall_package
  print_agent_config_locations
}

main "$@"
