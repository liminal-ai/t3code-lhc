# 0.0.40-lhc.4

Upstream remains v0.0.40. Sidecar pin is LHC `f04b483a` (accepted S1/S2). No Work launcher or SDK upgrade.

- **Claude LHC auth.** LHC uses the same Claude login as stock Claude Code (`CLAUDE_CONFIG_DIR` or `~/.claude`). After compact it writes a projected native transcript and resumes that UUID. Claude's own memory files stay Claude-owned; T3 does not copy tokens or rewrite HOME. An explicit Read of a memory file is not automatic memory discovery.
- **Continuation and titles.** Stock Claude and LHC on one home are different identities. Switching LHC or the config directory on an existing instance does not convert or drop the stored resume cursor; a mismatch is refused. Native LHC sessions are titled `[LHC]` plus the T3 thread id.
- **Access modes.** Unset settings keep all four modes and Full access as the new-thread default. A configured allowlist and default apply to new drafts and submit; the composer label matches the sent mode. Disallowed create, mode-set, and turn-start are rejected. Empty allowlist is invalid.
- **T3 MCP.** **Settings → Projects → T3 built-in MCP** (on by default) attaches T3's preview MCP only. Off dominates project browser-access overrides. Claude user/project/local MCP is unchanged.
