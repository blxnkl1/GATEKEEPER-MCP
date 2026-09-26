#!/usr/bin/env bash
#
# Add GATEKEEPER MCP to Claude Code.
#
# Usage:
#   bash install.sh                          # asks for a path, uses user scope
#   bash install.sh /path/to/gatekeeper-mcp  # explicit repo path, user scope
#   bash install.sh /path/to/gatekeeper-mcp project
#
# The path must point at the repository, not at dist/index.js: this script
# appends dist/index.js itself and refuses to run if the build output is missing,
# because a registered server that cannot start is the most common way this goes
# wrong and the failure only shows up later as an agent with no tools.

set -euo pipefail

readonly SERVER_NAME="gatekeeper"

usage() {
  cat <<'EOF'
Usage: bash install.sh [REPO_DIR] [local|user|project]

  REPO_DIR  Path to the gatekeeper-mcp checkout. Default: the current directory.
  SCOPE     local (default), user, or project.

Examples:
  bash install.sh
  bash install.sh ~/src/gatekeeper-mcp
  bash install.sh ~/src/gatekeeper-mcp project
EOF
}

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

main() {
  if ! command -v claude >/dev/null 2>&1; then
    fail "claude CLI not found. Install Claude Code, then re-run this script."
  fi

  local repo_dir="${1:-$PWD}"
  local scope="${2:-local}"
  local entry="${repo_dir%/}/dist/index.js"

  case "$scope" in
    local | user | project) ;;
    *)
      usage >&2
      fail "unknown scope: ${scope}"
      ;;
  esac

  if [ ! -d "$repo_dir" ]; then
    fail "not a directory: ${repo_dir}"
  fi

  # A registered server whose entrypoint is missing still appears in
  # `claude mcp list`, so it fails silently later. Catch it here.
  if [ ! -f "$entry" ]; then
    fail "${entry} does not exist. Run 'npm ci && npm run build' in ${repo_dir} first."
  fi

  log "registering ${SERVER_NAME} (${scope} scope)"
  log "  entrypoint: ${entry}"

  # `--` is required: everything after it is the command, not a claude flag.
  claude mcp add "$SERVER_NAME" --scope "$scope" -- node "$entry"

  log ""
  log "added. confirm with:"
  log "  claude mcp get ${SERVER_NAME}"
  log ""
  log "Note: project-scope servers in .mcp.json show 'Pending approval' until a"
  log "human approves them on first run. Use the local or user scope if you"
  log "want the server connected without that interactive step."
}

main "$@"
