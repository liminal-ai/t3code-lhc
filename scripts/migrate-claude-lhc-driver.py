#!/usr/bin/env python3
"""Move the existing "Claude LHC" instance and its threads to the `claude-lhc` driver kind.

Usage: slice4-migrate-claude-lhc.py <userdata dir> [--apply]
Without --apply: prints the plan and the row counts, changes nothing.
Run against a COPY first (`--copy-from ~/.t3code/userdata <dest>` makes one with a consistent sqlite backup).
Requires: server stopped for the target dir (live), python3 only (no sqlite3 CLI needed). Idempotent.
"""
import json, shutil, sqlite3, sys
from pathlib import Path

INSTANCE = "claude-lhc"
OLD_KIND, NEW_KIND = "claudeAgent", "claude-lhc"
TABLES = ("projection_thread_sessions", "provider_session_runtime")

def copy_userdata(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=False)
    shutil.copy2(src / "settings.json", dst / "settings.json")
    with sqlite3.connect(f"file:{src/'state.sqlite'}?mode=ro", uri=True) as s, sqlite3.connect(dst / "state.sqlite") as d:
        s.backup(d)  # consistent snapshot including the WAL
    print(f"copied settings.json + state.sqlite (backup API) -> {dst}")

def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["--copy-from"]:
        copy_userdata(Path(args[1]).expanduser(), Path(args[2]).expanduser()); args = args[2:]
    root = Path(args[0]).expanduser(); apply = "--apply" in args
    settings_path, db_path = root / "settings.json", root / "state.sqlite"
    settings = json.loads(settings_path.read_text())
    inst = settings.get("providerInstances", {}).get(INSTANCE)
    if inst is None: print(f"no providerInstances.{INSTANCE}; nothing to do"); return 0
    plan = []
    if inst.get("driver") == OLD_KIND: plan.append(f"providerInstances.{INSTANCE}.driver: {OLD_KIND} -> {NEW_KIND}")
    elif inst.get("driver") != NEW_KIND: print(f"refusing: driver is {inst.get('driver')!r}"); return 2
    for key, entry in settings["providerInstances"].items():
        if isinstance(entry.get("config"), dict) and "lhc" in entry["config"]:
            plan.append(f"providerInstances.{key}.config.lhc ({entry['config']['lhc']!r}): removed (field no longer exists)")
    legacy = (settings.get("providers") or {}).get(OLD_KIND) or {}
    if "lhc" in legacy: plan.append(f"providers.{OLD_KIND}.lhc: removed")
    con = sqlite3.connect(db_path)
    counts = {t: con.execute(f"select count(*) from {t} where provider_instance_id=? and provider_name=?", (INSTANCE, OLD_KIND)).fetchone()[0] for t in TABLES}
    counts["provider_session_runtime.adapter_key"] = con.execute("select count(*) from provider_session_runtime where provider_instance_id=? and adapter_key=?", (INSTANCE, OLD_KIND)).fetchone()[0]
    for t, n in counts.items():
        if n: plan.append(f"{t}: {n} row(s) provider_name {OLD_KIND} -> {NEW_KIND} where provider_instance_id={INSTANCE}")
    print("plan:" if plan else "already migrated; nothing to do"); [print("  " + p) for p in plan]
    if not apply or not plan: return 0
    backup = settings_path.with_name(f"settings.json.bak-claude-lhc-driver"); shutil.copy2(settings_path, backup)
    inst["driver"] = NEW_KIND
    for entry in settings["providerInstances"].values():
        if isinstance(entry.get("config"), dict): entry["config"].pop("lhc", None)
    legacy.pop("lhc", None)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    with con:
        for t in TABLES:
            con.execute(f"update {t} set provider_name=? where provider_instance_id=? and provider_name=?", (NEW_KIND, INSTANCE, OLD_KIND))
        # the runtime row also names the adapter that owns its resume cursor
        con.execute("update provider_session_runtime set adapter_key=? where provider_instance_id=? and adapter_key=?", (NEW_KIND, INSTANCE, OLD_KIND))
    after = {t: con.execute(f"select provider_name, count(*) from {t} where provider_instance_id=? group by 1", (INSTANCE,)).fetchall() for t in TABLES}
    print(f"applied; settings backup at {backup}"); [print(f"  {t}: {rows}") for t, rows in after.items()]
    return 0

if __name__ == "__main__": sys.exit(main())
