#!/bin/bash
# Development helper script
# Usage: ./dev.sh [command1] [command2] ...
#   commands: format | lint | typecheck | test | bundle | all | help
#   plus any commands provided by modules (scripts/dev-*.sh, dev/*.sh, dev-*.sh)
#   Multiple commands can be specified and will execute left to right

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

inf() { echo -e "${BLUE}[INFO]${NC} $1"; }
scs() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }
wrn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

# --- Module registry ---

declare -A CMD_DESCS
declare -a CMD_ORDER

dev_desc() {
    local cmd="$1"
    local desc="$2"
    if [[ -z "${CMD_DESCS[$cmd]+x}" ]]; then
        CMD_ORDER+=("$cmd")
    fi
    CMD_DESCS[$cmd]="$desc"
}

# --- Core commands ---

cmd_format() {
    inf "Formatting code..."
    bunx biome format --write .
    scs "Formatting completed"
}
dev_desc format "Format code with \"bunx biome format --write .\""

cmd_lint() {
    inf "Linting code..."
    bunx biome check .
    scs "Linting completed"
}
dev_desc lint "Run linter with \"bunx biome check .\""

cmd_typecheck() {
    inf "Typechecking..."
    bunx tsc --noEmit
    scs "Typecheck completed"
}
dev_desc typecheck "Run typecheck with \"bunx tsc --noEmit\""

cmd_test() {
    inf "Running tests..."
    bun test
    scs "Tests completed"
}
dev_desc test "Run the test suite with \"bun test\""

cmd_bundle() {
    inf "Building bundle..."
    bun build src/index.ts --outdir dist
    scs "Bundle completed"
}
dev_desc bundle "Build bundle with \"bun build src/index.ts --outdir dist\""

cmd_all() {
    inf "Running all tasks..."
    cmd_format
    cmd_lint
    cmd_typecheck
    cmd_test
    cmd_bundle
    scs "All tasks completed"
}
dev_desc all "Run format, lint, typecheck, test, and bundle in sequence"

# --- Module discovery ---

discover_modules() {
    local pat f
    for pat in "scripts/dev-*.sh" "dev/*.sh" "dev-*.sh"; do
        shopt -s nullglob
        for f in ${SCRIPT_DIR}/${pat}; do
            [ -f "$f" ] || continue
            inf "Loading module: $(basename "$f")"
            source "$f"
        done
        shopt -u nullglob
    done
}

discover_modules

# --- Help function ---

show_help() {
    cat << EOF
Development Helper Script

Usage: ./dev.sh [command1] [command2] ...

Commands:
EOF
    local cmd
    for cmd in "${CMD_ORDER[@]}"; do
        printf '  %-12s - %s\n' "$cmd" "${CMD_DESCS[$cmd]}"
    done
    cat << EOF

Multiple commands can be specified and will execute sequentially from left to right.

Examples:
  ./dev.sh format                  # Format code
  ./dev.sh lint                    # Run linter
  ./dev.sh typecheck               # Run typecheck
  ./dev.sh test                    # Run tests
  ./dev.sh bundle                  # Build bundle
  ./dev.sh format lint             # Format then lint
  ./dev.sh all                     # Run format, lint, typecheck, test, bundle

EOF
}

execute_command() {
    local command="$1"
    local fn="cmd_${command//-/_}"

    case "$command" in
        help)
            show_help
            ;;
        all)
            cmd_all
            ;;
        *)
            if declare -F "$fn" &>/dev/null; then
                "$fn"
            else
                err "Unknown command: $command"
                show_help
                exit 1
            fi
            ;;
    esac
}

if [ $# -eq 0 ]; then
    show_help
    exit 0
fi

for command in "$@"; do
    execute_command "$command"
done
