#!/usr/bin/env bash
# Remove a DevEco Code Linux x64 installation. The Command Line Tools are not
# touched; remove those separately if needed.
set -euo pipefail

PREFIX="${DEVECO_PREFIX:-$HOME/.local}"
BIN_DIR=""
PURGE=0

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]

Options:
  --prefix <dir>   Install prefix (default: $HOME/.local)
  --bin-dir <dir>  Directory containing the deveco symlink (default: <prefix>/bin)
  --purge          Also remove ~/.config/deveco and ~/.local/state/deveco
                   (configuration and login credentials)
  -h, --help       Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) echo "error: unexpected argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PREFIX" in
  ""|"/") echo "error: refusing prefix '$PREFIX'" >&2; exit 1 ;;
esac

SHARE_DIR="$PREFIX/share/deveco"
BIN_DIR="${BIN_DIR:-$PREFIX/bin}"
LINK="$BIN_DIR/deveco"

if [ -L "$LINK" ]; then
  rm -f "$LINK"
  echo "Removed $LINK"
elif [ -e "$LINK" ]; then
  echo "warning: $LINK is not a symlink; leaving it in place" >&2
fi

if [ -d "$SHARE_DIR" ]; then
  rm -rf "$SHARE_DIR"
  echo "Removed $SHARE_DIR"
fi

if [ "$PURGE" -eq 1 ]; then
  for dir in "$HOME/.config/deveco" "$HOME/.local/state/deveco"; do
    if [ -e "$dir" ]; then
      rm -rf "$dir"
      echo "Removed $dir"
    fi
  done
fi

echo "DevEco Code uninstalled."
