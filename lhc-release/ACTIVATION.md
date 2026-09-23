# Activation: t3code-lhc <version> on the live box

Order is fixed: **stop → install → migrate → start**. The old server's settings watcher must not see a migrated
settings.json, and the migration must come from the store version being activated. Fill `<…>` per release; the
concrete handoff for a release lives with its campaign evidence.

## Preflight

1. Reed's go received; seats idle (no running turns on the live server).
2. Note the current receipt: `python3 -c 'import json;print(json.load(open("~/.local/share/t3code-lhc/receipt.json".replace("~",__import__("os").environ["HOME"])))["version"])'` → `<previous>`.
3. Back up `~/.t3code/userdata/settings.json` and `~/.t3code/userdata/state.sqlite` (copy both; the sqlite copy via
   `sqlite3 state.sqlite ".backup <dest>"`).
4. Take the local archive build: `t3code-lhc-<version>-linux-x64.tar.gz` and its `.sha256` (built on this box with
   `scripts/build-lhc-archive.ts`; there are no downloadable archives); verify `sha256sum -c`. `install-lhc.sh` is in
   the archive under `scripts/` and in the repo.

## Activate

5. **Stop** the service unit.
6. **Install**: `bash install-lhc.sh --archive t3code-lhc-<version>-linux-x64.tar.gz` (flips `current`;
   receipt.previous keeps `<previous>`).
7. **Settings** the release's handoff names (for example a fork setting the live box keeps on), edited in
   `~/.t3code/userdata/settings.json` while the server is stopped.
   7b. **Migrate** with the store's copy, three runs, on live userdata:
   `python3 ~/.local/share/t3code-lhc/current/scripts/migrate-claude-lhc-driver.py ~/.t3code/userdata`
   (dry-run: read the plan), then `… --apply`, then `… --apply` again (must print "already migrated; nothing to do").
8. **Start** the unit.

## Verify

9. `~/.local/share/t3code-lhc/bin/t3code-lhc --lhc-version` prints `t3code-lhc <version> (upstream <tag>)`;
   receipt.json version matches.
10. Server log: migrations clean, no errors in the first minute; both seats resume on their threads; the LHC sidebar
    renders.
11. Report to Lee (the seats are down during the restart, so report directly).

## Rollback

Stop the unit → `bash ~/.local/share/t3code-lhc/current/scripts/install-lhc.sh --use <previous>` → restore the
settings.json (and state.sqlite if the migration touched rows) from step 3 → start → verify `--lhc-version` = `<previous>`.
