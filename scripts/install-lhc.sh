#!/usr/bin/env bash
# Install or update the t3code-lhc server archive into a versioned store.
#
#   install-lhc.sh                      # fetch releases/latest, install if its version differs from the receipt
#   install-lhc.sh --archive FILE       # install a local archive (FILE.sha256 must sit beside it)
#   install-lhc.sh --use VERSION        # repoint `current` at an already installed version (rollback)
#
# Options: --prefix DIR (default ~/.local/share/t3code-lhc), --releases-url URL,
#          --arch x64|arm64 (default: host), --platform linux|darwin|win32 (default: host),
#          --force (replace an installed version dir).
#
# Store layout under PREFIX:
#   versions/<version>/   extracted archive (manifest.json, apps/server/dist, node_modules,
#                         vendor/claude-lhc)
#   current -> versions/<version>   swapped atomically, only after the extracted tree
#                                   answers `--lhc-version` with the manifest's identity
#   bin/t3code-lhc        launcher: sets CLAUDE_LHC_SIDECAR to
#                         current/vendor/claude-lhc/dist/sidecar.js unless already set,
#                         then exec node current/apps/server/dist/bin.mjs
#   bin/t3code-lhc.cmd    Windows server wrapper (same env, then node)
#   receipt.json          { version, upstreamTag, prefix, name, source, sha256, installedAt, previous }
#
# Versions are compared for equality only, never ordered (FORK.md). Node >= 24.3
# and an authenticated Claude Code CLI are runtime prerequisites. Old versions
# are never deleted. systemd is never touched.
set -euo pipefail

PREFIX="${HOME}/.local/share/t3code-lhc"
RELEASES_URL="https://api.github.com/repos/liminal-ai/t3code-lhc/releases/latest"
ARCHIVE=""
USE_VERSION=""
FORCE=0
PLATFORM=""
ARCH=""

die() { echo "install-lhc: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --releases-url) RELEASES_URL="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    --use) USE_VERSION="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node is required (>= 24.3) and was not found on PATH"
node -e 'const [maj, min] = process.versions.node.split(".").map(Number); if (!(maj > 24 || (maj === 24 && min >= 3))) process.exit(1)' \
  || die "node >= 24.3 is required, found $(node --version)"

if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=darwin ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) PLATFORM=win32 ;;
    *) die "unsupported host $(uname -s); pass --platform linux|darwin|win32" ;;
  esac
fi
case "$PLATFORM" in
  linux|darwin|win32) ;;
  *) die "unsupported --platform $PLATFORM (linux, darwin, win32)" ;;
esac

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "unsupported host architecture $(uname -m); pass --arch" ;;
  esac
fi
case "$PLATFORM-$ARCH" in
  linux-x64|darwin-arm64|win32-x64) ;;
  *) die "no archive for $PLATFORM-$ARCH (supported: linux-x64, darwin-arm64, win32-x64)" ;;
esac

STORE="${PREFIX:?}/versions"
CURRENT="$PREFIX/current"
RECEIPT="$PREFIX/receipt.json"
LAUNCHER="$PREFIX/bin/t3code-lhc"
WIN_LAUNCHER="$PREFIX/bin/t3code-lhc.cmd"
SUFFIX="-${PLATFORM}-${ARCH}.tar.gz"
mkdir -p "$STORE" "$PREFIX/bin"

receipt_field() { # $1 field; empty if no receipt
  [ -f "$RECEIPT" ] || { echo ""; return; }
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r[process.argv[2]]??""))' "$RECEIPT" "$1"
}

manifest_field() { # $1 dir, $2 field
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1]+"/manifest.json","utf8"));process.stdout.write(String(m[process.argv[2]]??""))' "$1" "$2"
}

write_launcher() {
  cat > "$LAUNCHER.tmp" <<'EOF'
#!/usr/bin/env bash
# t3code-lhc launcher: runs the server from the store's `current` version.
# Bundled claude-lhc JS entry is discovered here, not by the server bridge.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
root="$(cd "$here/.." && pwd)"
bundled="$root/current/vendor/claude-lhc/dist/sidecar.js"
if [ -z "${CLAUDE_LHC_SIDECAR:-}" ] && [ -f "$bundled" ]; then
  export CLAUDE_LHC_SIDECAR="$bundled"
fi
exec node "$root/current/apps/server/dist/bin.mjs" "$@"
EOF
  chmod +x "$LAUNCHER.tmp"
  mv -f "$LAUNCHER.tmp" "$LAUNCHER"
  cat > "$WIN_LAUNCHER.tmp" <<'EOF'
@echo off
setlocal
set "ROOT=%~dp0.."
if not defined CLAUDE_LHC_SIDECAR if exist "%ROOT%\current\vendor\claude-lhc\dist\sidecar.js" set "CLAUDE_LHC_SIDECAR=%ROOT%\current\vendor\claude-lhc\dist\sidecar.js"
node "%ROOT%\current\apps\server\dist\bin.mjs" %*
EOF
  mv -f "$WIN_LAUNCHER.tmp" "$WIN_LAUNCHER"
}

swap_current() { # $1 version
  ln -sfn "versions/$1" "$CURRENT.tmp"
  mv -Tf "$CURRENT.tmp" "$CURRENT"
}

write_receipt() { # version upstreamTag name source sha256 previous
  node -e '
const [version, upstreamTag, prefix, name, source, sha256, previous, out] = process.argv.slice(1);
const receipt = { version, upstreamTag, prefix, name, source, sha256, installedAt: new Date().toISOString(), previous: previous === "" ? null : previous };
require("fs").writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
' "$1" "$2" "$PREFIX" "$3" "$4" "$5" "$6" "$RECEIPT"
}

PREVIOUS="$(receipt_field version)"

# --use: repoint at an installed version, no download.
if [ -n "$USE_VERSION" ]; then
  [ -d "$STORE/$USE_VERSION" ] || die "version $USE_VERSION is not in the store ($STORE)"
  TAG="$(manifest_field "$STORE/$USE_VERSION" upstreamTag)"
  NAME="$(manifest_field "$STORE/$USE_VERSION" name)"
  swap_current "$USE_VERSION"
  write_launcher
  write_receipt "$USE_VERSION" "$TAG" "$NAME" "store" "$(receipt_field sha256)" "$PREVIOUS"
  echo "install-lhc: current -> $USE_VERSION (from store)"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-lhc.XXXXXX")"
trap 'rm -rf "${WORK:?}"' EXIT

if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
  [ -f "$ARCHIVE.sha256" ] || die "checksum file not found: $ARCHIVE.sha256"
  NAME="$(basename "$ARCHIVE")"
  SOURCE="$(readlink -f "$ARCHIVE")"
  cp "$ARCHIVE" "$WORK/$NAME"
  cp "$ARCHIVE.sha256" "$WORK/$NAME.sha256"
else
  echo "install-lhc: reading $RELEASES_URL"
  # GITHUB_TOKEN, when set, only authenticates the releases JSON read (hosted
  # runners share an anonymous rate limit); asset downloads stay anonymous.
  auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  curl -fsSL "${auth[@]}" "$RELEASES_URL" -o "$WORK/release.json" || die "could not read releases JSON at $RELEASES_URL"
  NAME="$(node -e '
const rel = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const suffix = process.argv[2];
const asset = (rel.assets ?? []).find((a) => a.name.startsWith("t3code-lhc-") && a.name.endsWith(suffix));
if (!asset) { console.error("no asset ending in " + suffix + " on release " + (rel.tag_name ?? "?")); process.exit(2); }
const sum = (rel.assets ?? []).find((a) => a.name === asset.name + ".sha256");
if (!sum) { console.error("no " + asset.name + ".sha256 asset"); process.exit(2); }
process.stdout.write(asset.name);
' "$WORK/release.json" "$SUFFIX")" || die "asset selection failed"
  URL="$(node -e 'const rel=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(rel.assets.find(a=>a.name===process.argv[2]).browser_download_url)' "$WORK/release.json" "$NAME")"
  SUM_URL="$(node -e 'const rel=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(rel.assets.find(a=>a.name===process.argv[2]+".sha256").browser_download_url)' "$WORK/release.json" "$NAME")"
  SOURCE="$URL"
fi

VERSION="${NAME#t3code-lhc-}"
VERSION="${VERSION%"$SUFFIX"}"
[ -n "$VERSION" ] && [ "$VERSION" != "$NAME" ] || die "archive name $NAME does not match t3code-lhc-<version>$SUFFIX"

# Equality check only: the receipt's version is the installed identity.
if [ "$PREVIOUS" = "$VERSION" ] && [ "$FORCE" = 0 ]; then
  echo "install-lhc: already at $VERSION (receipt); nothing to do"
  exit 0
fi
if [ -d "$STORE/$VERSION" ] && [ "$FORCE" = 0 ]; then
  die "version $VERSION is already in the store; use --use $VERSION to activate it or --force to replace it"
fi

if [ -z "$ARCHIVE" ]; then
  echo "install-lhc: downloading $NAME"
  curl -fsSL "$URL" -o "$WORK/$NAME" || die "download failed: $URL"
  curl -fsSL "$SUM_URL" -o "$WORK/$NAME.sha256" || die "download failed: $SUM_URL"
fi

(cd "$WORK" && sha256sum -c --quiet "$NAME.sha256") || die "sha256 mismatch for $NAME; refusing to install"
SHA256="$(cut -d' ' -f1 "$WORK/$NAME.sha256")"

PARTIAL="$STORE/${VERSION:?}.partial"
rm -rf "${PARTIAL:?}"
mkdir -p "$PARTIAL"
tar -xzf "$WORK/$NAME" -C "$PARTIAL" || { rm -rf "${PARTIAL:?}"; die "extraction failed"; }

M_VERSION="$(manifest_field "$PARTIAL" version)"
M_TAG="$(manifest_field "$PARTIAL" upstreamTag)"
[ "$M_VERSION" = "$VERSION" ] || { rm -rf "${PARTIAL:?}"; die "manifest version '$M_VERSION' does not match archive name version '$VERSION'"; }
EXPECTED="t3code-lhc $M_VERSION (upstream $M_TAG)"
PRINTED="$(cd "$PARTIAL" && node apps/server/dist/bin.mjs --lhc-version 2>/dev/null || true)"
[ "$PRINTED" = "$EXPECTED" ] || { rm -rf "${PARTIAL:?}"; die "identity check failed: got '$PRINTED', want '$EXPECTED'; current left untouched"; }

TARGET="$STORE/${VERSION:?}"
rm -rf "${TARGET:?}"
mv -T "$PARTIAL" "$TARGET"
swap_current "$VERSION"
write_launcher
write_receipt "$VERSION" "$M_TAG" "$NAME" "$SOURCE" "$SHA256" "$PREVIOUS"
echo "install-lhc: installed $VERSION (upstream $M_TAG) -> $TARGET; current updated; launcher $LAUNCHER"
