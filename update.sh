#!/usr/bin/env bash
# Update an existing DevEco Code Linux x64 installation from a local release
# archive or directory. Never downloads anything.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${DEVECO_PREFIX:-$HOME/.local}"
SHARE_DIR="$PREFIX/share/deveco"

if [ ! -d "$SHARE_DIR" ]; then
  echo "DevEco Code is not installed at $SHARE_DIR; run install.sh first." >&2
  exit 1
fi

exec "$SCRIPT_DIR/install.sh" "$@"
