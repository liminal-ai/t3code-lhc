# t3code-lhc — LHC context management for t3code

Fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) adding a
[Claude LHC](https://github.com/liminal-ai/long-horizon-context) provider: the
Claude Agent SDK driven through the `claude-lhc` sidecar, so every thread has an
event-sourced record and banded compaction instead of native auto-compact; plus
an importer for existing LHC threads (one command, live or offline) and routing of Codex/Grok
provider updates to our own forks. No feature work rides on this repo beyond
that. Everything here exists to make the fork simple to sync, build, release,
and trust.

## Topology

- `origin` = `liminal-ai/t3code-lhc`. `main` is the product and the only
  permanent branch. Releases are cut from `main`.
- `upstream` = `pingdotgg/t3code`. Upstream ancestry is preserved in `main`;
  upstream tags are never pushed to `origin` (`remote.origin.tagOpt=--no-tags`,
  `push.followTags=false`). Fetch them from `upstream` when a sync needs them.
- Work happens in a worktree off `main`; a slice lands on `main` only after
  review of the diff.

## Baseline and version

- `lhc-release/BASE` is the upstream commit `main` is built on;
  `lhc-release/BASE_TAG` is the upstream tag that commit was released as
  (today `v0.0.40`). Both advance together on every sync.
- `lhc-release/version.json` is the identity both `t3 --lhc-version` and the
  server's environment descriptor (`lhcFork`) read. Its `version` is the
  upstream version we incorporate, `BASE_TAG` minus the leading `v`, including
  a nightly's full string; it is _not_ `package.json`'s `version`, which
  upstream leaves at the last stable. A fork-only fix landed between syncs
  appends `-lhc.N` (N from 1), dropped again at the next sync. The check
  script keeps `version.json` and `BASE_TAG` in step. Current identity:
  `0.0.40-lhc.5` on `v0.0.40`; sidecar pin in `lhc-release/sidecar.json` is LHC
  `5f181303`. User-facing notes: `lhc-release/NOTES.md`.
- Fork versions are never ordered by code, here or in any installer: "latest"
  is GitHub's latest-release marker, and every check is an equality check.
  `-lhc.N` sorts below its base under semver and nightly strings already carry
  a prerelease part, so any comparison would be wrong.

## Footprint and the check

- `lhc-release/INVENTORY` lists every path that differs from `BASE`, grouped as
  fork-owned files, upstream touches, and tests. Upstream touches stay minimal
  and additive; new behaviour goes in new files.
- `scripts/check-lhc-touch.sh [head]` verifies: `BASE` is an ancestor, the tag
  peels to it, every upstream workflow is deleted and only `lhc-*` workflows
  survive, and the inventory matches the diff in both directions. It runs in
  `.github/workflows/lhc-quality.yml` on every push to `main`, alongside
  `vp check`, `vpr typecheck`, and the server/contracts/web tests.
- Run `vp check` and the tests in a clean worktree with its own install, never
  in the live checkout: it carries untracked artifacts (`dist.prev-*`) that
  stop the check at formatting before lint, so a pass there is false.

## Sync drill (detail lands with the first controlled sync)

1. `git fetch upstream --tags`; pick the newest upstream release published at
   least 24h ago; skip if `BASE_TAG` already is it.
2. In a worktree off `main`: `git merge <tag>^{commit}`; resolve conflicts only
   on inventoried paths; `git rm` every `.github/workflows/*` not prefixed
   `lhc-` (upstream re-adds them; keep them deleted).
3. Update `BASE`, `BASE_TAG`, `version.json`, `INVENTORY`; run `scripts/check-lhc-touch.sh`,
   `vp check`, `vpr typecheck`, the tests, and the Claude LHC seam check below;
   record conflicts, checks, the `claude:` review field, and wall time in the
   sync record. Fast-forward `main` after review.

## Claude LHC driver (fork-only)

Why a separate kind. `claude-lhc` is its own driver kind next to stock
`claudeAgent` (`packages/contracts/src/claudeDriverKinds.ts`). A stock and an
LHC instance on the same home never share a continuation group, LHC threads are
identifiable by kind in settings and the DB, and the sidecar is always injected
rather than flag-gated (the pre-lhc.5 `lhc: true` flag is gone; existing rows
move with `scripts/migrate-claude-lhc-driver.py`).

The seam it depends on. Three optional fields on `ClaudeAdapterOptions` in
`apps/server/src/provider/Layers/ClaudeAdapter.ts`: `driverKind` (stamped on
provider events, defaults to `claudeAgent`), `createQuery({ ..., threadId })`
(replaces the SDK `query` call for the generation), and `threadId` on the
cursor/resume input. `ClaudeDriver.ts` exports `makeClaudeDriver(spec)`;
`apps/server/src/provider/Drivers/ClaudeLhcDriver.ts` builds the kind from it
with `createQuery: makeClaudeLhcCreateQuery` (`ClaudeLhcSidecar.ts`, which owns
`T3CODE_THREAD_ID` and the sidecar spawn) and its own continuation prefix.
Runtime, probe, capabilities, text generation, and result/error mapping are
inherited unchanged.

Per-sync seam check. After the merge step of the drill, `vpr typecheck` and

```
vp test run apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/server/src/provider/Drivers/ClaudeLhcDriver.test.ts \
  apps/server/src/provider/Drivers/ClaudeLhcSidecar.test.ts
```

must pass before the sync is recorded. The adapter test injects a fake
`createQuery` and asserts it receives `threadId`; typecheck fails if upstream
removes or renames any of the three fields. A failure is a sync blocker, not a
follow-up.

Review rule. Every upstream commit in the sync range that touches
`ClaudeAdapter.ts`, `ClaudeProvider.ts`, or `ClaudeDriver.ts` is read for
behavior the LHC driver must carry (new adapter options, result/error mapping,
resume/cursor shape, usage reporting) or that bypasses the seam (a second SDK
`query` call site, a new env line). The outcome goes in the sync record line as
`claude: <n> commit(s), <carried: ...|none>`. `ClaudeLhcSidecar.ts` is
fork-owned and outside this rule; an SDK pin bump there is a fork change,
tracked by the LHC pin line in `lhc-release/RELEASES.md`.

## Archive, install, launcher (slice 4)

- Build: `node scripts/build-lhc-archive.ts` (flags `--skip-build`, `--keep-stage`,
  `--platform linux|darwin|win32`, `--arch`, `--out`). Produces
  `dist-lhc/t3code-lhc-<version>-<platform>-<arch>.tar.gz` plus `.sha256` for
  linux-x64, darwin-arm64, and win32-x64; inside: `manifest.json`, `apps/server/dist`
  (web client at `dist/client`, no source maps), `node_modules` (runtime externals
  staged like the desktop sidecar, fff natives for the target, Linux pty.node
  compiled on the Linux builder, Mac/Windows node-pty prebuilds with
  `spawn-helper` mode 0755, Windows `@ff-labs/fff-bin-win32-` and
  `@yuuang/ffi-rs-win32-` kept despite the shared WSL exclude list), and
  `vendor/claude-lhc` (compiled `dist/sidecar.js`, built `lhc` dist, JS closure from
  `lhc-release/sidecar.json`; after npm, `node_modules/lhc` is copied as a real
  directory — Windows npm 11.16 still junctions `file:./lhc` even with
  `install-links=true`). Optional `@anthropic-ai/claude-agent-sdk-*`
  platform packages are not shipped: T3 passes `pathToClaudeCodeExecutable`.
  The script refuses to emit an archive whose extracted tree does not answer
  `--lhc-version` with the manifest identity.
  Builds are reproducible: two builds of one commit give one sha256 (no build time
  in the manifest, tar mtimes pinned to the commit time, `gzip -n`).
- Install or update: `scripts/install-lhc.sh [--archive FILE | --use VERSION]`.
  Store at `~/.local/share/t3code-lhc`: `versions/<version>/`, `current` (POSIX
  symlink, or a Windows directory junction via `scripts/lib/lhc-store.ts`; Git
  Bash `ln -s` copies and is not used), `bin/t3code-lhc` launcher,
  `receipt.json` (version, upstreamTag, prefix, name, source, sha256,
  installedAt, previous). Run `scripts/install-lhc.sh` from Git Bash on Windows
  (PowerShell cannot execute it). `mv` of the extracted tree is portable (no GNU
  `mv -T`). Checksums use Node crypto. Windows drive-letter prefixes are
  converted with Git `cygpath` before GNU tar `-C`.
  With no `--archive` it reads
  `liminal-ai/t3code-lhc` releases/latest and installs only if the asset version
  differs from the receipt: equality, never ordering. Old versions stay; rollback
  is `--use <version>`. It never touches systemd. Tests: `scripts/install-lhc.test.sh`.
- Launcher: `<prefix>/bin/t3code-lhc` sets `CLAUDE_LHC_SIDECAR` to
  `current/vendor/claude-lhc/dist/sidecar.js` unless it is already set, then execs
  `node current/apps/server/dist/bin.mjs`. Windows also writes `t3code-lhc.cmd`
  (server wrapper only). The server always `spawn(process.execPath, [entry])`.
  Activation on this box (not done yet): change the last line of
  `~/.t3code/run-server.sh` from `node /srv/work/t3code/apps/server/dist/bin.mjs ...`
  to `"$HOME/.local/share/t3code-lhc/bin/t3code-lhc" ...` with the same arguments and
  environment, then restart `t3code-3773.service`.
- Release tags on the fork repo are `lhc-v<version>` (upstream tags are fetched
  into the same local namespace, so a bare `v0.0.40` would clash). The displayed
  version stays `<version>` without the prefix.

## CLI text that still names npm `t3` (documented exclusion)

Upstream text that suggests `npx t3 ...` is left untouched so no extra upstream
file joins the inventory: `apps/server/src/cli/invocation.ts` (`formatCliCommand`
prints `t3 <subcommand>` for a non-runner entry path, so an archive install is
told `t3 serve`; read it as `t3code-lhc serve`), `cli/pair.ts` (`npx t3 serve` /
`npx t3 connect`), `cli/service.ts` (`npx t3@<version> service update`) and
`cli/triagePrompt.ts`. `t3 service` and server self-update install the npm
package and are unsupported on the fork build; an archive install advertises no
self-update capability (`cloud/selfUpdate.ts`: not desktop- or boot-service-managed),
so the UI's update path is inert.

## Release (slice 5)

`lhc-release.yml` is dispatch only (a tag never triggers it).

- Candidate: dispatch with `promote` unchecked and `candidate_run_id` empty. Native jobs build linux-x64,
  darwin-arm64, and win32-x64 under Node 24.3 with GNU tar (macOS `gnu-tar`,
  Windows Git `usr/bin/tar.exe`) and npm 11.16.0 installed into an isolated
  `RUNNER_TEMP` prefix (not the T3 pnpm workspace; not the Node-bundled 11.4.2),
  run the two scripts tests on Linux, prove the
  Linux archive on a clean host (`scripts/lhc-clean-host-proof.sh`: identity, UI,
  packaged sidecar stdin-EOF under Node), then install each native artifact on
  its OS and prove `--lhc-version` plus sidecar stdin-EOF. Upload each
  `<name>.tar.gz`, `.sha256`, `.manifest.json` (14 days).
- Qualification: those jobs green, plus the local gate on the same artifact:
  install into a scratch prefix and port with the live sidecar, the campaign's
  13-step smoke against it (tool turns, manual compact, restart, resume), one
  stock desktop client against that port. Recorded in the campaign evidence.
- Promote: dispatch `promote=true` **and** `candidate_run_id` of a successful
  same-SHA candidate run after Mac/Windows authenticated lifecycle on those
  exact bytes. That path downloads the frozen three artifacts (`actions:read`
  plus `contents:write`, same pattern as Codex `lhc-release-promote.yml`) and
  does not rebuild. `promote=true` without `candidate_run_id` fails. A tag exists only
  for a promoted build. An existing tag or release fails the run: never
  re-promote, publish `<upstream>-lhc.N+1`. Releases are never deleted or moved.
- Public check: a fresh runner runs `scripts/install-lhc.sh` with no `--archive`
  against releases/latest, requires the launcher to print the promoted identity,
  and requires a second run to no-op ("already at").
- Record: one line per promoted release in `lhc-release/RELEASES.md`.
- Release standard (same text as LHC `docs/releases/README.md`; keep the two
  identical): qualification runs on the exact commit that is promoted, not an
  earlier candidate; at least one live model turn on the shipped artifact
  before promotion, fixture-only burn-ins do not count; a bug fix ships only
  after the bug was reproduced on the pre-fix build, and the release note cites
  the reproduction.

## Access-mode settings (fork-only, informational)

Two server settings, both on Settings → Projects, ship with the fork:
`defaultRuntimeMode` (default `auto`; a new thread with nothing carried over
starts there) and `hideFullAccess` (default off; when on, the composer does not
list Full access). Neither is enforced: the provider's own permission policy
remains the only enforcer, existing threads keep their mode, and no command is
rejected for its mode. Setting `hideFullAccess` while the default is
`full-access` is rejected on write naming both fields; a settings file that
already carries that pair is read as `auto` with a warning and left untouched.
The seed leaves both at their defaults. On a locked-down box set
`defaultRuntimeMode = auto` and `hideFullAccess = true` in Settings by hand.

## Default instance seed (fork-only)

Stock synthesizes one instance per built-in driver from `providers.<kind>`
(`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`), keyed by
the driver kind, with the schema-default binary name on PATH. The fork adds
three rows (`apps/server/src/provider/forkInstanceSeed.ts`): `claude-lhc`
(driver `claude-lhc`), `codex-lhc` (driver `codex`, binary `codex-lhc`, update
source LHC) and `grok-lhc` (driver `grok`, binary `grok-lhc`), each enabled,
accent `#7c3aed`. A row is written once into `settings.json`
(`providerInstances`) the first time its fork binary is detected while its id
is absent: the sidecar file `CLAUDE_LHC_SIDECAR` points at, `codex-lhc` and
`grok-lhc` on PATH. The write goes through the server's settings-update
command (the same path as a Settings save: validation, normalize, atomic
write, change emission), and logs `provider.instance.seed.persisted` per row.
The rows must be persisted rather than merged in memory because the web client
lists a non-default instance only when it exists in `providerInstances`
(lhc.5 shipped an in-memory seed and the picker hid it).

Rules: an existing row with the same id is never touched, whatever it says
(explicit wins, never rewritten). A seeded row behaves like a driver default:
disable it, do not delete it; a deleted row comes back on the next settings
change or server restart while the binary is present. Nothing is written
while the binary is absent, and a binary removed later leaves its row (the
instance then shows its own binary error). Availability is probed when
settings load and on every settings change; the Providers refresh button only
re-probes snapshots, so a fork binary installed later is written on the next
settings save or server restart. The stock `codex` and `grok` rows keep their
schema-default names, so which build they run is whatever `codex` / `grok`
resolve to on PATH.

## Never run here

`npx t3@latest`, `t3 service install` pointing at the npm package, any
self-update path, or anything that touches the running server's `dist/`. The
fork is installed from `liminal-ai/t3code-lhc` releases only.

## Prerequisites (declared, not bundled)

Node >= 24.3 (qualified 24.3; Linux also regresses on operational 24.18) and an
authenticated Claude Code CLI, plus provider CLIs for Codex/Grok when those
providers are enabled. The sidecar itself is in the archive as compiled JS; a
source checkout of long-horizon-context is not required. `CLAUDE_LHC_SIDECAR`
overrides the bundled JS entry. The archive builder clones
`lhc-release/sidecar.json`'s commit; it does not copy a developer working tree.
Source-build recipe: Node 24.3, npm 11.16.0 for the LHC pin install (the Node
24.3 bundle is 11.4.2 and is refused), GNU tar (`gtar` / Git `usr/bin/tar.exe`;
System32 and BSD `tar` are not enough), then `node scripts/build-lhc-archive.ts`.
Override with `LHC_ARCHIVE_TAR` / `LHC_ARCHIVE_NPM` (path to that isolated
prefix's `node_modules/npm/bin/npm-cli.js`). Do not lower
third-party `engines` blindly. The builder runs `tsc` as
`process.execPath [typescript/bin/tsc, ...]` from the pin's own install, then
prunes devDependencies. Vite+ is `process.execPath [node_modules/vite-plus/bin/vp, ...]`,
not `node_modules/.bin/vp`. GNU tar child PATH includes that tar's directory so
Windows Git `gzip` is reachable.
