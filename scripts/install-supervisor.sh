#!/bin/sh
# Build and install the sensorium-supervisor Go binary.
# Requires Go 1.22+ installed and on PATH.
set -e

FORCE="${1:-}"
DATA_DIR="$HOME/.remote-copilot-mcp"
BIN_DIR="$DATA_DIR/bin"
BINARY="$BIN_DIR/sensorium-supervisor"

# Find supervisor source relative to this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUPERVISOR_DIR="$(dirname "$SCRIPT_DIR")/supervisor"

if [ ! -f "$SUPERVISOR_DIR/go.mod" ]; then
    echo "ERROR: Cannot find supervisor source at $SUPERVISOR_DIR" >&2
    exit 1
fi

# Check Go is available
if ! command -v go >/dev/null 2>&1; then
    echo "ERROR: Go is not installed. Install from https://go.dev/dl/ (requires Go 1.22+)" >&2
    exit 1
fi

echo "Found $(go version)"

# Skip if binary is newer than source (unless --force)
if [ "$FORCE" != "--force" ] && [ -f "$BINARY" ]; then
    NEWEST_SRC=$(find "$SUPERVISOR_DIR" -name '*.go' -newer "$BINARY" 2>/dev/null | head -1)
    if [ -z "$NEWEST_SRC" ]; then
        echo "sensorium-supervisor is up to date ($BINARY)"
        exit 0
    fi
fi

mkdir -p "$BIN_DIR"

echo "Building sensorium-supervisor..."
cd "$SUPERVISOR_DIR"
go build -o "$BINARY" .

echo "Installed: $BINARY"
