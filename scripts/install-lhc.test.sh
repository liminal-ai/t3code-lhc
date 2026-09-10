#!/usr/bin/env bash
# Tests for scripts/install-lhc.sh against fake archives (stub bin.mjs that
# prints the identity line) in a scratch prefix. Run: scripts/install-lhc.test.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/install-lhc.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/install-lhc-test.XXXXXX")"
trap 'rm -rf "${T:?}"' EXIT
PREFIX="$T/prefix"
ASSETS="$T/assets"; mkdir -p "$ASSETS"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1" >&2; }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }

# make_fake_archive <version> <upstreamTag> [printedVersion]
make_fake_archive() {
  local v="$1" tag="$2" printed="${3:-$1}" name="t3code-lhc-$1-linux-x64.tar.gz" s="$T/stage-$1"
  mkdir -p "$s/apps/server/dist/client" "$s/node_modules" "$s/vendor/claude-lhc/dist"
  printf '{"name":"%s","version":"%s","upstreamTag":"%s","platform":"linux","arch":"x64","sidecar":{"repository":"https://github.com/liminal-ai/long-horizon-context.git","commit":"1ba4cee9768514aa7358e8dba5f69b5c108dcdae","claudeAgentSdk":"0.3.170"}}\n' "$name" "$v" "$tag" > "$s/manifest.json"
  printf 'if (process.argv[2] === "--lhc-version") { console.log("t3code-lhc %s (upstream %s)"); process.exit(0); }\nconsole.log("stub server", process.argv.slice(2).join(" "));\nif (process.env.CLAUDE_LHC_SIDECAR) console.error("sidecar=" + process.env.CLAUDE_LHC_SIDECAR);\n' "$printed" "$tag" > "$s/apps/server/dist/bin.mjs"
  echo "<html></html>" > "$s/apps/server/dist/client/index.html"
  echo "export {};" > "$s/vendor/claude-lhc/dist/sidecar.js"
  (cd "$s" && tar -czf "$ASSETS/$name" manifest.json apps node_modules vendor)
  node -e 'const fs=require("fs");const crypto=require("crypto");const f=process.argv[1];const h=crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");fs.writeFileSync(f+".sha256",h+"  "+require("path").basename(f)+"\n");' "$ASSETS/$name"
  echo "$ASSETS/$name"
}

A="$(make_fake_archive 0.0.40 v0.0.40)"
B="$(make_fake_archive 0.0.41-lhc.1 v0.0.41)"
C="$(make_fake_archive 0.0.42 v0.0.42 0.0.99)"   # manifest says 0.0.42, binary says 0.0.99

echo "1. fresh install from --archive"
"$INSTALL" --prefix "$PREFIX" --archive "$A" >/dev/null
check "current -> versions/0.0.40" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$PREFIX")" = "0.0.40" ]'
check "launcher prints identity" '[ "$("$PREFIX/bin/t3code-lhc" --lhc-version)" = "t3code-lhc 0.0.40 (upstream v0.0.40)" ]'
check "windows cmd wrapper exists" '[ -f "$PREFIX/bin/t3code-lhc.cmd" ]'
bundled="$PREFIX/current/vendor/claude-lhc/dist/sidecar.js"
launcher_sidecar="$(env -u CLAUDE_LHC_SIDECAR "$PREFIX/bin/t3code-lhc" serve 2>&1 >/dev/null || true)"
check "launcher sets CLAUDE_LHC_SIDECAR from current/" '[[ "$launcher_sidecar" == *"sidecar=$bundled"* ]]'
override_sidecar="$(CLAUDE_LHC_SIDECAR=/tmp/override-sidecar "$PREFIX/bin/t3code-lhc" serve 2>&1 >/dev/null || true)"
check "explicit CLAUDE_LHC_SIDECAR override wins" '[[ "$override_sidecar" == *"sidecar=/tmp/override-sidecar"* ]]'
check "receipt fields" 'node -e "const r=require(process.argv[1]);process.exit(r.version===\"0.0.40\"&&r.upstreamTag===\"v0.0.40\"&&r.prefix===process.argv[2]&&r.name===\"t3code-lhc-0.0.40-linux-x64.tar.gz\"&&r.source.endsWith(\"/assets/t3code-lhc-0.0.40-linux-x64.tar.gz\")&&/^[0-9a-f]{64}$/.test(r.sha256)&&r.previous===null&&!!Date.parse(r.installedAt)?0:1)" "$PREFIX/receipt.json" "$PREFIX"'
check "no partial dir left" '[ -z "$(ls -d "$PREFIX"/versions/*.partial 2>/dev/null)" ]'

echo "2. same version again is a no-op"
before="$(stat -c %Y "$PREFIX/receipt.json")"; sleep 1
out="$("$INSTALL" --prefix "$PREFIX" --archive "$A")"
check "says already at" '[[ "$out" == *"already at 0.0.40"* ]]'
check "receipt untouched" '[ "$(stat -c %Y "$PREFIX/receipt.json")" = "$before" ]'

echo "3. update from a mock releases/latest to a different version"
cat > "$T/latest.json" <<EOF
{"tag_name":"lhc-v0.0.41-lhc.1","assets":[
 {"name":"README.md","browser_download_url":"file://$T/nope"},
 {"name":"t3code-lhc-0.0.41-lhc.1-linux-x64.tar.gz","browser_download_url":"file://$B"},
 {"name":"t3code-lhc-0.0.41-lhc.1-linux-x64.tar.gz.sha256","browser_download_url":"file://$B.sha256"}]}
EOF
out="$(env -u GITHUB_TOKEN "$INSTALL" --prefix "$PREFIX" --releases-url "file://$T/latest.json")"
check "http path with GITHUB_TOKEN absent" '[[ "$out" == *"installed 0.0.41-lhc.1"* ]]'
check "current -> versions/0.0.41-lhc.1" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$PREFIX")" = "0.0.41-lhc.1" ]'
check "old version kept" '[ -d "$PREFIX/versions/0.0.40" ]'
check "receipt previous=0.0.40, source is the url" 'node -e "const r=require(process.argv[1]);process.exit(r.previous===\"0.0.40\"&&r.version===\"0.0.41-lhc.1\"&&r.source.startsWith(\"file://\")?0:1)" "$PREFIX/receipt.json"'
check "launcher follows current" '[ "$("$PREFIX/bin/t3code-lhc" --lhc-version)" = "t3code-lhc 0.0.41-lhc.1 (upstream v0.0.41)" ]'

echo "4. updater with the same version as the receipt does nothing (no download)"
out="$(env -u GITHUB_TOKEN "$INSTALL" --prefix "$PREFIX" --releases-url "file://$T/latest.json")"
check "says already at" '[[ "$out" == *"already at 0.0.41-lhc.1"* ]]'

echo "5. corrupted checksum refuses before extraction"
D="$T/corrupt"; mkdir -p "$D"; cp "$A" "$D/t3code-lhc-0.0.40-linux-x64.tar.gz"
echo "0000000000000000000000000000000000000000000000000000000000000000  t3code-lhc-0.0.40-linux-x64.tar.gz" > "$D/t3code-lhc-0.0.40-linux-x64.tar.gz.sha256"
set +e; "$INSTALL" --prefix "$PREFIX" --archive "$D/t3code-lhc-0.0.40-linux-x64.tar.gz" --force >"$T/out5" 2>&1; rc=$?; set -e
check "non-zero exit" '[ "$rc" != 0 ]'
check "mentions sha256" 'grep -q "sha256 mismatch" "$T/out5"'
check "current unchanged" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$PREFIX")" = "0.0.41-lhc.1" ]'
check "no partial dir" '[ -z "$(ls -d "$PREFIX"/versions/*.partial 2>/dev/null)" ]'

echo "6. identity mismatch refuses before the swap"
set +e; "$INSTALL" --prefix "$PREFIX" --archive "$C" >"$T/out6" 2>&1; rc=$?; set -e
check "non-zero exit" '[ "$rc" != 0 ]'
check "mentions identity" 'grep -q "identity check failed" "$T/out6"'
check "current unchanged" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$PREFIX")" = "0.0.41-lhc.1" ]'
check "no 0.0.42 dir and no partial" '[ ! -e "$PREFIX/versions/0.0.42" ] && [ -z "$(ls -d "$PREFIX"/versions/*.partial 2>/dev/null)" ]'

echo "7. --use rolls back to a stored version"
"$INSTALL" --prefix "$PREFIX" --use 0.0.40 >/dev/null
check "current -> versions/0.0.40" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$PREFIX")" = "0.0.40" ]'
check "receipt source=store, previous=0.0.41-lhc.1" 'node -e "const r=require(process.argv[1]);process.exit(r.source===\"store\"&&r.previous===\"0.0.41-lhc.1\"&&r.version===\"0.0.40\"?0:1)" "$PREFIX/receipt.json"'
set +e; "$INSTALL" --prefix "$PREFIX" --use 9.9.9 >/dev/null 2>&1; rc=$?; set -e
check "--use of an unknown version fails" '[ "$rc" != 0 ]'

echo "8. installed version dir without --force is refused, not replaced"
set +e; "$INSTALL" --prefix "$PREFIX" --archive "$B" >"$T/out8" 2>&1; rc=$?; set -e
check "refused" '[ "$rc" != 0 ] && grep -q "already in the store" "$T/out8"'

REAL="$(ls "$HERE"/../dist-lhc/t3code-lhc-*-linux-x64.tar.gz 2>/dev/null | head -1 || true)"
if [ -n "$REAL" ]; then
  echo "9. real archive installs into a scratch prefix and answers --lhc-version"
  P2="$T/prefix-real"
  "$INSTALL" --prefix "$P2" --archive "$REAL" >/dev/null
  check "launcher identity from real archive" '[[ "$("$P2/bin/t3code-lhc" --lhc-version)" == "t3code-lhc "*" (upstream "*")" ]]'
else
  echo "9. (skipped: no dist-lhc archive built)"
fi

echo "10. checksum uses Node crypto when sha256sum is not on PATH"
P10="$T/prefix-nosha"
mkdir -p "$T/nosh"
cat > "$T/nosh/sha256sum" <<'EOF'
#!/bin/sh
echo "sha256sum should not be called" >&2
exit 127
EOF
chmod +x "$T/nosh/sha256sum"
out="$(PATH="$T/nosh:$PATH" "$INSTALL" --prefix "$P10" --archive "$A")"
check "installs without sha256sum" '[[ "$out" == *"installed 0.0.40"* ]]'
check "current after node checksum" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$P10")" = "0.0.40" ]'

echo "11. Windows-style prefix is converted with cygpath"
P11="$T/win-prefix"
mkdir -p "$T/cygpath-bin"
cat > "$T/cygpath-bin/cygpath" <<EOF
#!/bin/sh
if [ "\$1" = "-u" ]; then
  printf '%s\\n' "$P11"
  exit 0
fi
exit 1
EOF
chmod +x "$T/cygpath-bin/cygpath"
out="$(PATH="$T/cygpath-bin:$PATH" "$INSTALL" --prefix 'D:\a\_temp\t3code-lhc' --archive "$A")"
check "installs into cygpath unix prefix" '[[ "$out" == *"installed 0.0.40"* ]]'
check "current under converted prefix" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$P11")" = "0.0.40" ]'
check "linux posix prefix still works" '[ "$(node "$HERE/lib/lhc-store.ts" read-current "$PREFIX")" = "0.0.40" ]'

echo "passed $PASS, failed $FAIL"
[ "$FAIL" = 0 ]
