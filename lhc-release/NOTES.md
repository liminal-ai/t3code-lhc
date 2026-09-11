# 0.0.40-lhc.4

Upstream remains v0.0.40.

- **Claude LHC.** LHC uses the same Claude login and settings as ordinary Claude Code (`CLAUDE_CONFIG_DIR` or `~/.claude`). Compact and resume stay in that home, so Claude's usual settings and memory files remain available. T3 does not copy credentials or change `HOME`. Native LHC sessions are titled `[LHC]` plus the T3 thread id.
- **Continuation.** Stock Claude and LHC on one home are different identities. Changing LHC or the config directory on an existing instance does not convert or drop a stored resume. Newly recorded resumes that no longer match are refused; older unmarked resumes still work.
- **Access modes.** Unset settings keep all four modes and Full access as the new-thread default. A configured allowlist and default apply to new drafts and submit; the composer label matches the sent mode. Disallowed create, mode-set, and turn-start are rejected. Empty allowlist is invalid.
- **T3 MCP.** **Settings → Projects → T3 built-in MCP** (on by default) attaches T3's preview MCP only. Off applies even when a project enables browser access. Claude's own MCP configuration is unchanged.
