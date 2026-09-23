# unreleased

Upstream v0.0.42 (synced since 0.0.40-lhc.8). Sidecar `claude-lhc` 0.1.0 from npm (LHC `0581e775`: LHC main
`b11b8e7a` plus the sidecar thread-id fix and the package). Local builds of this line on the live box:
`0.0.42-lhc.1-local.1` to `-local.3` (RELEASES.md).

- **Source releases.** A public release is now a tag on a soaked commit plus these notes; there are no public
  archives or desktop builds. Install from a checkout with `scripts/setup-lhc-source.sh` (checks Node and pnpm,
  installs dependencies and the sidecar, builds the server). `lhc-release.yml` and the clean-host proof are retired;
  `install-lhc.sh` installs local archive builds only (`--archive` / `--use`, no download).
- **Sidecar from npm.** `lhc-release/sidecar.json` records the `claude-lhc` package version instead of an LHC commit;
  the archive build installs that package (or `--sidecar-tarball`, a local pack of the same version) instead of
  cloning and compiling the LHC repo, and no longer needs npm 11.16.
- **Sidecar thread id.** `T3CODE_THREAD_ID`, which the driver sets on the sidecar, now reaches Claude Code and its
  shells, so `lhc-agent` in a Claude LHC seat resolves its sender without `--from`.
- **Roundtable (alpha).** The group-chat view over lhc-console: a Roundtable section in the LHC sidebar with
  working / unread / failed indicators, `/roundtable/<id>` with member activity, @mentions and default-recipient
  checkboxes, and a server proxy `/api/groups/*` to the console with its owner token. Behind the server setting
  **Roundtable (alpha)** (`roundtableEnabled`, off by default; requires lhc-console). Off: no sidebar section, the
  route goes home, the proxy answers 404. Toggling needs no restart.
- **Sidebar activity (Agents).** Agent rows show upstream's status pill (working, completed, failed) and age.
- **Upstream v0.0.42 sync.** Upstream's changes to copied regions were ported into the fork's Agents section
  (FORK.md "Copies of upstream code").

# 0.0.40-lhc.8

Upstream remains v0.0.40. Sidecar pin LHC `fffdcc8e` (LHC main head at cut; cc-lhc 0.4.2 version commit, sidecar tree unchanged from `8f5c3276`).

- **LHC sidebar fixes (F1, F3, F4).** Agent rows reserve room for the always-visible Unpin / Archive icons on touch widths, so they sit beside the time instead of over it. The phone drawer is the full window in portrait (under 600px) and upstream's sheet width above that; before, an invalid inline width let the drawer size to its content. Agent rows show a bold title and an accent dot when the latest turn completed after you last opened the thread (never while Running); opening the thread clears it. Not changed: the one-refresh lag after rename / pin / delete is the server round trip in every view; the remove-project warning toast is fully in view once its slide-in finishes, and it carries Dismiss and "Delete anyway".
- **Helpers shipped in the archive.** `scripts/install-lhc.sh` and `scripts/migrate-claude-lhc-driver.py` are packed under `<archive>/scripts/` and listed in `manifest.json` (`scripts`), so the store's `current/scripts/` carries the install and migration tools the activation handoff runs. The archive build now checks for npm 11.16 up front (before the server build) and names `LHC_ARCHIVE_NPM` in the failure.
- **Activation template.** `lhc-release/ACTIVATION.md`: stop → install → migrate → start, with rollback.

# 0.0.40-lhc.7

Upstream remains v0.0.40. Sidecar pin LHC `8f5c3276`.

- **LHC sidebar.** A third left-nav view (**Settings → General → Sidebar**; LHC is the fork default): an Agents section (pinned threads, ordered by last turn, right-click the header to group by project) above the projects tree without pinned threads; both sections collapse from their headers; one-line rows with visible hover and selection. Rows under Projects offer "Pin as agent"; agent rows offer Unpin, plus the usual single-row actions against the thread's own project. Removing a project still counts its pinned agents. Built as the fork-owned Agents section over the upstream legacy tree through a small declared seam in `LegacySidebar.tsx` (FORK.md "LHC sidebar"). Deferred: thread-jump hint badges on agent rows.
- **Sidebar setting.** The legacy sidebar switch becomes a Threads / Projects / LHC select on Settings → General. Unset resolves to LHC; a legacy-on browser still gets Projects; an explicit pick always wins.
- **Claude LHC compact settings.** The `claude-lhc` instance form gains **Auto-compact after** (`autoCompactWindow`, default 380000) and **Rebuilt view size** (`lhcLowerBound`, default 150000), both in provider-billed tokens and both required; the lower bound must be below the trigger. The sidecar builds the post-compact view to the configured bound instead of a ratio of the trigger, so a compact can no longer re-trigger on the next turn. `scripts/migrate-claude-lhc-driver.py` fills both fields on existing instances; run it at activation.
- **Provider-aware token estimator (sidecar).** LHC `8f5c3276`: token estimates are weighted per tokenizer family (Claude 2026 models 1.55× the o200k count), resolved from the model t3code sends at session start and shown in compact notes. Existing records are unchanged; only the estimate changes.

# 0.0.40-lhc.6

Upstream remains v0.0.40. Sidecar pin LHC `5f181303`.

- **Default LHC instances are now written to settings.** lhc.5 kept `claude-lhc`, `codex-lhc`, and `grok-lhc` in memory only, and the web picker hid them. Each row is now written once into `settings.json` the first time its binary is detected while the id is absent, through the normal settings save. An existing row with the same id is never touched. Treat a seeded row like a driver default: disable it rather than delete it; a deleted row comes back on the next settings change while the binary is present.
- **Stock Grok stays off by default.** Upstream's default disables the stock `grok` provider; enable it in **Settings → Providers**. The seeded `grok-lhc` row is enabled on its own.

# 0.0.40-lhc.5

Upstream remains v0.0.40. Sidecar pin LHC `5f181303`.

- **Claude LHC is its own driver.** Provider kind `claude-lhc` next to stock Claude. It always runs through the LHC sidecar; the `lhc` checkbox is gone. Existing Claude LHC instances and their threads are moved by `scripts/migrate-claude-lhc-driver.py` (dry run by default, `--apply` writes with a backup). A stock and an LHC instance on the same home never share a resume.
- **Default LHC instances.** `claude-lhc`, `codex-lhc`, and `grok-lhc` appear automatically while their binary is present (sidecar file, `codex-lhc` or `grok-lhc` on PATH), enabled, with the LHC accent. They are not written to settings; an explicit entry with the same id wins. Stock `codex` and `grok` keep their default binary names.
- **Access-mode settings.** **Settings → Projects** gains a new-thread default mode and a switch that hides Full access from the pickers. Informational: nothing is enforced at submit.
- **MCP status warning.** A Claude turn (stock or LHC) whose T3 MCP attachment is not connected logs a warning naming the status.
- **Removed since lhc.4.** The access-mode allowlist with rejection, the T3 built-in MCP toggle, and the continuation-identity refusal are reverted to v0.0.40 behavior. The Claude LHC login/home behavior below still holds.

# 0.0.40-lhc.4

Upstream remains v0.0.40.

- **Claude LHC.** LHC uses the same Claude login and settings as ordinary Claude Code (`CLAUDE_CONFIG_DIR` or `~/.claude`). Compact and resume stay in that home, so Claude's usual settings and memory files remain available. T3 does not copy credentials or change `HOME`. Native LHC sessions are titled `[LHC]` plus the T3 thread id.
- **Continuation.** Stock Claude and LHC on one home are different identities. Changing LHC or the config directory on an existing instance does not convert or drop a stored resume. Newly recorded resumes that no longer match are refused; older unmarked resumes still work.
- **Access modes.** Unset settings keep all four modes and Full access as the new-thread default. A configured allowlist and default apply to new drafts and submit; the composer label matches the sent mode. Disallowed create, mode-set, and turn-start are rejected. Empty allowlist is invalid.
- **T3 MCP.** **Settings → Projects → T3 built-in MCP** (on by default) attaches T3's preview MCP only. Off applies even when a project enables browser access. Claude's own MCP configuration is unchanged.
