#!/usr/bin/env bash
# Set up t3code-lhc from a source checkout (the public release form; FORK.md "Release").
#
#   scripts/setup-lhc-source.sh [--sidecar-tarball FILE] [--skip-build]
#
# 1. Checks Node (root package.json engines) and pnpm (packageManager, exact).
# 2. pnpm install --frozen-lockfile.
# 3. Installs the Claude LHC sidecar: the claude-lhc npm package at the version
#    lhc-release/sidecar.json records, into .lhc/sidecar (git-ignored).
#    --sidecar-tarball installs a local pack of that same version instead.
# 4. Builds the server (web client bundled): vp run --filter t3 build.
# Then prints the command that runs the server with CLAUDE_LHC_SIDECAR set.
# Never touches a running server, systemd, or ~/.t3code. Re-running is safe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL=""
BUILD=1
die() { echo "setup-lhc-source: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --sidecar-tarball) TARBALL="$2"; shift 2 ;;
    --skip-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
cd "$ROOT"

command -v node >/dev/null 2>&1 || die "node was not found on PATH"
node -e '
const need = require("./package.json").engines.node.replace(/^>=\s*/, "").split(".").map(Number);
const have = process.versions.node.split(".").map(Number);
for (let i = 0; i < 3; i += 1) {
  if ((have[i] ?? 0) > (need[i] ?? 0)) process.exit(0);
  if ((have[i] ?? 0) < (need[i] ?? 0)) process.exit(1);
}' || die "node $(node -p 'require("./package.json").engines.node') is required, found $(node --version)"

PNPM_WANT="$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')"
command -v pnpm >/dev/null 2>&1 || die "pnpm $PNPM_WANT is required (corepack enable, or npm install -g pnpm@$PNPM_WANT)"
PNPM_HAVE="$(pnpm --version)"
[ "$PNPM_HAVE" = "$PNPM_WANT" ] || die "pnpm $PNPM_WANT is required, found $PNPM_HAVE"

echo "setup-lhc-source: installing workspace dependencies"
pnpm install --frozen-lockfile

PKG="$(node -p 'require("./lhc-release/sidecar.json").package')"
VERSION="$(node -p 'require("./lhc-release/sidecar.json").version')"
SIDECAR_DIR="$ROOT/.lhc/sidecar"
if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || die "sidecar tarball not found: $TARBALL"
  SPEC="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
else
  SPEC="$PKG@$VERSION"
fi
echo "setup-lhc-source: installing the sidecar ($SPEC)"
rm -rf "$SIDECAR_DIR"
mkdir -p "$SIDECAR_DIR"
printf '{"name":"t3code-lhc-sidecar","private":true}\n' > "$SIDECAR_DIR/package.json"
npm install --prefix "$SIDECAR_DIR" --omit=dev --no-fund --no-audit --no-package-lock "$SPEC"
INSTALLED="$(node -p "require('$SIDECAR_DIR/node_modules/$PKG/package.json').version")"
[ "$INSTALLED" = "$VERSION" ] || die "installed $PKG@$INSTALLED, but lhc-release/sidecar.json records $VERSION"
ENTRY="$SIDECAR_DIR/node_modules/$PKG/dist/sidecar.js"
[ -f "$ENTRY" ] || die "$PKG@$VERSION has no dist/sidecar.js"

if [ "$BUILD" = 1 ]; then
  echo "setup-lhc-source: building the server and web client"
  pnpm exec vp run --filter t3 build
fi

cat <<EOF
setup-lhc-source: done ($PKG@$VERSION).
Run the server with:
  CLAUDE_LHC_SIDECAR="$ENTRY" node "$ROOT/apps/server/dist/bin.mjs" serve
Claude LHC also needs an authenticated Claude Code CLI (FORK.md "Prerequisites").
EOF
