#!/usr/bin/env bash
#
# Installer for GATEKEEPER MCP.
#
# Installs dependencies, builds the project, and prints the configuration needed
# to wire the server into a coding agent. Run it from a clone of the repository.

set -euo pipefail

readonly REQUIRED_NODE_MAJOR=20
readonly PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  # Logs go to stderr so this script stays pipeable and never pollutes stdout.
  printf '%s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

# 1. Verify the runtime.
check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    fail "node is not installed. Install Node.js ${REQUIRED_NODE_MAJOR} or newer from https://nodejs.org"
  fi

  local node_version node_major
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"

  if ! [[ "$node_major" =~ ^[0-9]+$ ]]; then
    fail "could not parse the Node.js version from '${node_version}'"
  fi

  if (( node_major < REQUIRED_NODE_MAJOR )); then
    fail "Node.js ${REQUIRED_NODE_MAJOR} or newer is required, found ${node_version}"
  fi

  log "node ${node_version} is supported"
}

# 2. Install and build.
build_project() {
  log "installing dependencies"
  (cd "$PROJECT_DIR" && npm ci)

  log "building"
  (cd "$PROJECT_DIR" && npm run build)

  log "verifying the build"
  (cd "$PROJECT_DIR" && npm run typecheck)

  log "gatekeeper-mcp installed in ${PROJECT_DIR}"
}

# 3. Tell the user how to wire it into their agent.
print_next_steps() {
  local bin_path="${PROJECT_DIR}/dist/index.js"

  cat >&2 <<EOF

GATEKEEPER MCP is installed.

The server speaks JSON-RPC on stdio, so an agent runs it as a local process.
Point your agent at:

  ${bin_path}

While Phase 1 is in progress the server is not published to npm, so use the
absolute path above instead of "npx gatekeeper-mcp".

Wire it into your agent:

  OpenCode      add to opencode.json:
                {
                  "mcp": {
                    "gatekeeper": {
                      "type": "local",
                      "command": ["node", "${bin_path}"],
                      "enabled": true
                    }
                  }
                }

  Codex         add to ~/.codex/config.toml:
                [mcp_servers.gatekeeper]
                command = "node"
                args = ["${bin_path}"]

  Claude Code   claude mcp add gatekeeper -- node ${bin_path}

  Hermes Agent  hermes mcp add gatekeeper -- node ${bin_path}

Then restart the agent and confirm it lists the pre_action_check tool.

Docs: docs/architecture.md for design, docs/phases.md for the roadmap.
EOF
}

main() {
  check_node_version
  build_project
  print_next_steps
}

main "$@"
