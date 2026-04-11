#!/bin/sh
# Launch sensorium-supervisor. Builds automatically if needed.
# Replaces update-watcher.ps1 on Unix systems.
set -e

MODE="${1:-production}"
DATA_DIR="$HOME/.remote-copilot-mcp"
BIN_DIR="$DATA_DIR/bin"
BINARY="$BIN_DIR/sensorium-supervisor"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build if missing
if [ ! -f "$BINARY" ]; then
    "$SCRIPT_DIR/install-supervisor.sh"
fi

export WATCHER_MODE="${WATCHER_MODE:-$MODE}"

echo "Starting sensorium-supervisor ($WATCHER_MODE mode)..."
exec "$BINARY"
