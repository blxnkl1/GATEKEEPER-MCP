#!/usr/bin/env bash
#
# GATEKEEPER MCP - installer
# Copyright (c) 2026 blxnkl1
# SPDX-License-Identifier: MIT
#
# Installs GATEKEEPER MCP globally from npm. This script does not clone the
# repository: the published package already contains the compiled server, so
# installing it is a single npm operation.
#
# To work on the project itself, clone instead:
#   git clone https://github.com/blxnkl1/GATEKEEPER-MCP.git
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/blxnkl1/GATEKEEPER-MCP/main/scripts/install.sh | bash
#
#   bash install.sh [options]
#
# Options:
#   --version <tag>   Version to install. Default: latest.
#   --prefix <dir>    Install prefix. Default: $HOME/.local
#   --dry-run         Print what would happen, then exit without changing anything.
#   -h, --help        Show this help.

set -euo pipefail

readonly PACKAGE_NAME="gatekeeper-mcp"
readonly REPO_URL="https://github.com/blxnkl1/GATEKEEPER-MCP"
readonly MIN_NODE_MAJOR=20

VERSION="latest"
PREFIX="${HOME}/.local"
DRY_RUN="false"

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || fail "--version requires a value"
        VERSION="$2"
        shift 2
        ;;
      --version=*)
        VERSION="${1#*=}"
        shift
        ;;
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

# The server is a Node program and there is no meaningful fallback for a missing
# runtime, so this is a hard stop rather than a warning.
check_os() {
  local kernel
  kernel="$(uname -s)"
  case "$kernel" in
    Darwin)
      info "detected OS: macOS"
      ;;
    Linux)
      info "detected OS: Linux"
      ;;
    *)
      fail "unsupported operating system: ${kernel}. This installer supports macOS and Linux only. On any other platform, install with: npm install -g ${PACKAGE_NAME}"
      ;;
  esac
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js ${MIN_NODE_MAJOR} or newer is required, but node was not found.
Install it, then re-run this script:
  macOS         brew install node
  Debian/Ubuntu sudo apt-get install -y nodejs npm
  Fedora        sudo dnf install -y nodejs
  Or download it from https://nodejs.org and re-open your shell."
  fi

  local raw major
  raw="$(node --version)"
  major="${raw#v}"
  major="${major%%.*}"

  if ! [[ "$major" =~ ^[0-9]+$ ]]; then
    fail "could not parse the Node.js version from '${raw}'"
  fi

  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node.js ${MIN_NODE_MAJOR} or newer is required, found ${raw}.
Upgrade Node.js, then re-run this script:
  macOS         brew upgrade node
  Debian/Ubuntu sudo apt-get install -y nodejs npm
  Or download it from https://nodejs.org and re-open your shell."
  fi

  info "node ${raw} is supported"
}

install_package() {
  # The version spec is built here so a "latest" install and a pinned install go
  # through exactly the same code path.
  local spec="${PACKAGE_NAME}"
  if [ "$VERSION" != "latest" ]; then
    spec="${PACKAGE_NAME}@${VERSION}"
  fi

  if [ "$DRY_RUN" = "true" ]; then
    info "[dry-run] would run: npm install -g --prefix ${PREFIX} ${spec}"
    return 0
  fi

  info "installing ${spec}"
  if ! npm install -g --prefix "$PREFIX" "$spec"; then
    fail "npm install failed. If you do not have write access to ${PREFIX}, choose another prefix: bash install.sh --prefix ~/.local"
  fi
  info "installed ${spec} into ${PREFIX}"
}

print_bin_hint() {
  local bindir="${PREFIX}/bin"
  if [ "$DRY_RUN" = "true" ]; then
    info "[dry-run] would verify with: ${bindir}/gatekeeper-mcp"
  else
    info "installed executable: ${bindir}/gatekeeper-mcp"
  fi

  case ":${PATH}:" in
    *":${bindir}:"*) ;;
    *)
      warn "${bindir} is not on your PATH. Add it:"
      warn "  export PATH=\"${bindir}:\$PATH\""
      ;;
  esac
}

print_next_steps() {
  local bindir="${PREFIX}/bin"
  local bin="${bindir}/gatekeeper-mcp"

  cat <<EOF

GATEKEEPER MCP is a local MCP server. It speaks JSON-RPC on stdio, so your
agent starts it as a child process. You do not run it by hand.

The package was just installed. Point your agent at the installed binary:

  OpenCode
    opencode mcp add gatekeeper -- ${bin}

  Claude Code
    claude mcp add gatekeeper -- ${bin}

  Hermes Agent
    hermes mcp add gatekeeper --command ${bin}
    (Hermes connects first, lists the tools it finds, then asks which to enable.
    Answer Y to enable pre_action_check.)

  Codex
    Unverified. See ${REPO_URL}/blob/main/docs/agents/codex.md

Confirm it is registered:

  opencode mcp list      # or: claude mcp list   /   hermes mcp list

Expect a row for the server with a connected status.

Prefer not to install globally? Uninstall it and let the agent fetch the package
on first start instead:

  npm uninstall -g --prefix ${PREFIX} ${PACKAGE_NAME}
  opencode mcp add gatekeeper -- npx -y ${PACKAGE_NAME}

The npx route downloads on first use, so the very first start can be slow enough
to trip your agent's MCP start-up timeout. A global install avoids that.

Full per-agent guides, with scopes and troubleshooting:
  ${REPO_URL}/tree/main/docs/agents

To uninstall:
  npm uninstall -g --prefix ${PREFIX} ${PACKAGE_NAME}
EOF
}

main() {
  parse_args "$@"

  info "GATEKEEPER MCP installer"
  info ""

  check_os
  check_node

  if [ "$DRY_RUN" = "true" ]; then
    info ""
    info "[dry-run] no changes will be made"
  fi

  install_package
  print_bin_hint
  print_next_steps
}

main "$@"
