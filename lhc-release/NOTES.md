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
