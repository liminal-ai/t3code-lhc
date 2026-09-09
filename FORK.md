# t3code-lhc — LHC context management for t3code

Fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) adding a
[Claude LHC](https://github.com/liminal-ai/long-horizon-context) provider: the
Claude Agent SDK driven through the `claude-lhc` sidecar, so every thread has an
event-sourced record and banded compaction instead of native auto-compact; plus
an offline importer for existing cc-lhc threads and routing of Codex/Grok
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
  (today `v0.0.39-nightly.20260904.1278`). Both advance together on every sync.
- The fork's version is the upstream version it incorporates, taken from
  `BASE_TAG` minus the leading `v`, including a nightly's full string. It is
  _not_ `package.json`'s `version`: upstream computes nightly strings at build
  time and leaves the tree at the last stable. A fork-only fix gets a fork
  revision suffix; the identity plumbing (VERSION file, CLI flag, server
  environment field) is the next slice.

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
3. Update `BASE`, `BASE_TAG`, `INVENTORY`; run `scripts/check-lhc-touch.sh`,
   `vp check`, `vpr typecheck`, the tests; record conflicts, checks, and wall
   time in the sync record. Fast-forward `main` after review.

## Never run here

`npx t3@latest`, `t3 service install` pointing at the npm package, any
self-update path, or anything that touches the running server's `dist/`. The
fork is installed from `liminal-ai/t3code-lhc` releases only.

## Prerequisites (declared, not bundled)

Node 24, the `claude-lhc` sidecar from the LHC repo (Bun runtime), and provider
CLIs for Codex/Grok when those providers are enabled.
