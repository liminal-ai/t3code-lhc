# Sync record

One line per controlled sync: date, upstream tag, new BASE sha, conflicts, `claude:` review
field (`claude: <n> commit(s), <carried: ...|none>` for upstream commits touching ClaudeAdapter.ts,
ClaudeProvider.ts, or ClaudeDriver.ts, per FORK.md "Claude LHC driver"), wall time (worktree add to
last green local check; the quality run is separate).

- 2026-09-09 | v0.0.40 | 09e8de9c6 | 8 paths: ci.yml + release.yml (rm), CodexDriver + GrokDriver (maintenance API port, 6 hunks), settings.ts + settings.test.ts (3), install.md + providers-codex.md (2); plus ClaudeLhcSidecar.ts onUserDialog requestId for claude-agent-sdk 0.3.260 | claude: 0 commits (base sync) | 16 min
