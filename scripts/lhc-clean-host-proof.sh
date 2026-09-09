#!/usr/bin/env bash
# Clean-host proof for a t3code-lhc archive: extract it in a slim Node image with
# no pnpm, no repo, and no ancestor node_modules, then require the sha256 to
# match, `--lhc-version` to equal the manifest identity, the server to serve the
# web UI, the environment descriptor to carry the same lhcFork identity, and the
# packaged claude-lhc launcher to import under Bun (stdin EOF; no model auth).
# Same file runs locally and in lhc-release.yml.
#
#   scripts/lhc-clean-host-proof.sh <archive.tar.gz> [--image node:24-bookworm-slim]
set -euo pipefail

ARCHIVE=""
IMAGE="node:24-bookworm-slim"
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "usage: $0 <archive.tar.gz> [--image IMAGE]" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE" >&2; exit 2; }
[ -f "$ARCHIVE.sha256" ] || { echo "checksum not found: $ARCHIVE.sha256" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }

DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
NAME="$(basename "$ARCHIVE")"

docker run --rm -v "$DIR:/in:ro" -e HOME=/tmp -e NAME="$NAME" "$IMAGE" bash -eu -o pipefail -c '
echo "node $(node --version); pnpm: $(command -v pnpm || echo absent); glibc: $(ldd --version | head -1 | awk "{print \$NF}")"
cd /in && sha256sum -c "$NAME.sha256"
[ ! -e /node_modules ] && [ ! -e /tmp/node_modules ] && [ ! -e /usr/local/lib/node_modules/t3 ] && echo "ancestor node_modules: none"
mkdir -p /tmp/x /tmp/data && cd /tmp/x && tar -xzf "/in/$NAME"
EXPECT="$(node -e "const m=require(\"/tmp/x/manifest.json\");process.stdout.write(\"t3code-lhc \"+m.version+\" (upstream \"+m.upstreamTag+\")\")")"
GOT="$(node apps/server/dist/bin.mjs --lhc-version)"
[ "$GOT" = "$EXPECT" ] || { echo "identity mismatch: got [$GOT] want [$EXPECT]"; exit 1; }
echo "--lhc-version: $GOT"
node apps/server/dist/bin.mjs serve --base-dir /tmp/data --port 3199 --host 127.0.0.1 --no-browser > /tmp/server.log 2>&1 &
PID=$!
for i in $(seq 1 60); do
  node -e "fetch(\"http://127.0.0.1:3199/.well-known/t3/environment\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 1
done
echo "server up after ${i}s"
node -e "
const m = require(\"/tmp/x/manifest.json\");
const base = \"http://127.0.0.1:3199\";
(async () => {
  const home = await fetch(base + \"/\");
  const html = await home.text();
  if (home.status !== 200 || !/^text\/html/.test(home.headers.get(\"content-type\") ?? \"\") || !html.includes(\"<html\")) throw new Error(\"GET / not html: \" + home.status);
  console.log(\"GET /: 200 text/html \" + html.length + \" bytes\");
  const env = await (await fetch(base + \"/.well-known/t3/environment\")).json();
  const fork = env.lhcFork ?? {};
  if (fork.version !== m.version || fork.upstreamTag !== m.upstreamTag) throw new Error(\"lhcFork mismatch: \" + JSON.stringify(env.lhcFork));
  console.log(\"environment: serverVersion \" + env.serverVersion + \", lhcFork \" + JSON.stringify(env.lhcFork));
})().catch((e) => { console.error(String(e)); process.exit(1); });
" || { tail -20 /tmp/server.log; kill $PID; exit 1; }
kill $PID
echo "installing bun (documented prerequisite; not bundled)"
apt-get update -qq
apt-get install -y -qq curl unzip ca-certificates >/dev/null
curl -fsSL https://bun.sh/install | bash
export PATH="/tmp/.bun/bin:${PATH}"
bun --version
test -x /tmp/x/vendor/claude-lhc/bin/claude-lhc
mkdir -p /tmp/lhc
T3CODE_LHC_HOME=/tmp/lhc /tmp/x/vendor/claude-lhc/bin/claude-lhc </dev/null
echo "sidecar stdin-eof: PASS"
echo "clean-host proof: PASS"
'
