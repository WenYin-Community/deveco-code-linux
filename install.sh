#!/usr/bin/env bash
# Install DevEco Code Linux x64 from a local release archive or directory.
# This script never downloads anything: get the release archive manually.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${DEVECO_PREFIX:-$HOME/.local}"
BIN_DIR=""
FORCE=0
SOURCE=""
TMP=""
OLD=""

usage() {
  cat <<'EOF'
Usage: install.sh [options] [source]

Install DevEco Code Linux x64 from a local directory or .tar.gz archive.
No network access is performed.

source may be:
  - a directory containing bin/deveco and vendor/
  - a .tar.gz release archive
  - omitted: this script's directory, its packages/opencode/dist/deveco-linux-x64,
    or the current directory, whichever contains bin/deveco

Options:
  --prefix <dir>   Install prefix (default: $HOME/.local)
  --bin-dir <dir>  Directory for the deveco symlink (default: <prefix>/bin)
  --force          Reinstall even when the version already matches
  -h, --help       Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) SOURCE="$1"; shift ;;
  esac
done

case "$PREFIX" in
  ""|"/") echo "error: refusing prefix '$PREFIX'" >&2; exit 1 ;;
esac

SHARE_DIR="$PREFIX/share/deveco"
BIN_DIR="${BIN_DIR:-$PREFIX/bin}"
LINK="$BIN_DIR/deveco"

cleanup() {
  [ -n "$TMP" ] && rm -rf "$TMP"
  [ -n "$OLD" ] && rm -rf "$OLD"
}
trap cleanup EXIT

if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
  case "$SOURCE" in
    *.tar.gz|*.tgz)
      TMP="$(mktemp -d)"
      tar -xzf "$SOURCE" -C "$TMP"
      SOURCE="$TMP"
      ;;
    *) echo "error: source must be a directory or .tar.gz archive" >&2; exit 1 ;;
  esac
fi

if [ -z "$SOURCE" ]; then
  for candidate in "$SCRIPT_DIR" "$SCRIPT_DIR/packages/opencode/dist/deveco-linux-x64" "$PWD"; do
    if [ -x "$candidate/bin/deveco" ] && [ -d "$candidate/vendor" ]; then
      SOURCE="$candidate"
      break
    fi
  done
fi

[ -n "$SOURCE" ] || { echo "error: no install source found (expected bin/deveco and vendor/)" >&2; exit 1; }
[ -x "$SOURCE/bin/deveco" ] || { echo "error: $SOURCE/bin/deveco is missing or not executable" >&2; exit 1; }
[ -d "$SOURCE/vendor" ] || { echo "error: $SOURCE/vendor is missing" >&2; exit 1; }

SOURCE_VERSION="$(cat "$SOURCE/VERSION" 2>/dev/null || true)"
[ -n "$SOURCE_VERSION" ] || SOURCE_VERSION="unknown"
INSTALLED_VERSION="$(cat "$SHARE_DIR/VERSION" 2>/dev/null || true)"

if [ "$SOURCE_VERSION" != "unknown" ] && [ "$SOURCE_VERSION" = "$INSTALLED_VERSION" ] && [ "$FORCE" -eq 0 ]; then
  echo "DevEco Code $SOURCE_VERSION is already installed at $SHARE_DIR"
  echo "Use --force to reinstall."
  exit 0
fi

mkdir -p "$PREFIX/share" "$BIN_DIR"
STAGING="$PREFIX/share/.deveco-staging.$$"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -a "$SOURCE/bin" "$SOURCE/vendor" "$STAGING/"
[ -f "$SOURCE/VERSION" ] && cp "$SOURCE/VERSION" "$STAGING/VERSION"
for helper in install.sh update.sh uninstall.sh; do
  [ -f "$SCRIPT_DIR/$helper" ] && cp "$SCRIPT_DIR/$helper" "$STAGING/$helper"
done

if [ -e "$SHARE_DIR" ]; then
  OLD="$PREFIX/share/.deveco-old.$$"
  rm -rf "$OLD"
  mv "$SHARE_DIR" "$OLD"
fi
mv "$STAGING" "$SHARE_DIR"
rm -rf "$OLD"
OLD=""

if [ -L "$LINK" ]; then
  rm -f "$LINK"
elif [ -e "$LINK" ]; then
  echo "error: $LINK exists and is not a symlink; remove it manually" >&2
  exit 1
fi
ln -s "$SHARE_DIR/bin/deveco" "$LINK"

echo "Installed DevEco Code $SOURCE_VERSION to $SHARE_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH, for example: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "warning: node not found; DevEco Code needs Node.js 22 or newer to run devecocli" >&2
elif ! node -e 'const [major] = process.versions.node.split(".").map(Number); process.exit(major >= 22 ? 0 : 1)'; then
  echo "warning: Node.js $(node -v) is older than 22" >&2
fi

if [ -z "${DEVECO_CLI_CLT_PATH:-}" ] && [ ! -d "$HOME/command-line-tools" ] && [ ! -d /opt/harmony-clt ]; then
  echo "note: install the HarmonyOS Command Line Tools and set DEVECO_CLI_CLT_PATH if they are not in ~/command-line-tools or /opt/harmony-clt"
fi

echo "Uninstall: $SHARE_DIR/uninstall.sh"
