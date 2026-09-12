// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

// scripts/migrate-claude-lhc-driver.py moves the pre-lhc.5 "Claude LHC" instance
// (driver claudeAgent + config.lhc) and its rows to the claude-lhc driver kind.
const SCRIPT = NodePath.resolve(
  import.meta.dirname,
  "../../../../scripts/migrate-claude-lhc-driver.py",
);
const hasPython = NodeChildProcess.spawnSync("python3", ["--version"]).status === 0;

function makeUserdata(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lhc-migrate-"));
  NodeFS.writeFileSync(
    NodePath.join(dir, "settings.json"),
    JSON.stringify({
      providerInstances: {
        "claude-lhc": {
          driver: "claudeAgent",
          displayName: "Claude LHC",
          enabled: true,
          config: { lhc: true, autoCompactWindow: "350000" },
        },
        claudeAgent: {
          driver: "claudeAgent",
          enabled: false,
          config: { lhc: false, homePath: "" },
        },
        codex: { driver: "codex", enabled: true },
      },
      providers: { claudeAgent: { lhc: true } },
    }),
  );
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "state.sqlite"));
  for (const table of ["projection_thread_sessions", "provider_session_runtime"]) {
    const extra = table === "provider_session_runtime" ? ", adapter_key text" : "";
    db.exec(
      `create table ${table} (thread_id text primary key, provider_name text, provider_instance_id text${extra})`,
    );
    db.exec(
      `insert into ${table} (thread_id, provider_name, provider_instance_id) values ('t1','claudeAgent','claude-lhc'),('t2','claudeAgent','claude-lhc'),('t3','claudeAgent','claudeAgent'),('t4','codex','codex'),('t5','claudeAgent','other-lhc')`,
    );
    if (extra !== "") db.exec(`update ${table} set adapter_key = provider_name`);
  }
  db.close();
  return dir;
}

const run = (dir: string, ...args: string[]) =>
  NodeChildProcess.spawnSync("python3", [SCRIPT, dir, ...args], { encoding: "utf8" });

const rows = (dir: string, table: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "state.sqlite"), { readOnly: true });
  const result = db
    .prepare(
      `select thread_id, provider_name, provider_instance_id from ${table} order by thread_id`,
    )
    .all();
  db.close();
  return result;
};

describe.skipIf(!hasPython)("migrate-claude-lhc-driver.py", () => {
  it("plans without changing anything, applies once, then reports nothing to do", () => {
    const dir = makeUserdata();
    const before = NodeFS.readFileSync(NodePath.join(dir, "settings.json"), "utf8");

    const dry = run(dir);
    expect(dry.stderr).toBe("");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("driver: claudeAgent -> claude-lhc");
    expect(dry.stdout).toContain("projection_thread_sessions: 2 row(s)");
    expect(NodeFS.readFileSync(NodePath.join(dir, "settings.json"), "utf8")).toBe(before);
    expect(rows(dir, "provider_session_runtime")).toMatchObject([
      { thread_id: "t1", provider_name: "claudeAgent" },
      {},
      {},
      {},
      {},
    ]);

    const applied = run(dir, "--apply");
    expect(applied.status).toBe(0);
    const settings = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "settings.json"), "utf8"));
    expect(settings.providerInstances["claude-lhc"]).toEqual({
      driver: "claude-lhc",
      displayName: "Claude LHC",
      enabled: true,
      config: { autoCompactWindow: "350000" },
    });
    expect(settings.providerInstances.claudeAgent.config).toEqual({ homePath: "" });
    expect(settings.providerInstances.codex).toEqual({ driver: "codex", enabled: true });
    expect(settings.providers.claudeAgent).toEqual({});
    expect(
      NodeFS.readFileSync(NodePath.join(dir, "settings.json.bak-claude-lhc-driver"), "utf8"),
    ).toBe(before);
    for (const table of ["projection_thread_sessions", "provider_session_runtime"]) {
      expect(rows(dir, table)).toEqual([
        { thread_id: "t1", provider_name: "claude-lhc", provider_instance_id: "claude-lhc" },
        { thread_id: "t2", provider_name: "claude-lhc", provider_instance_id: "claude-lhc" },
        { thread_id: "t3", provider_name: "claudeAgent", provider_instance_id: "claudeAgent" },
        { thread_id: "t4", provider_name: "codex", provider_instance_id: "codex" },
        { thread_id: "t5", provider_name: "claudeAgent", provider_instance_id: "other-lhc" },
      ]);
    }

    const runtimeKeys = new NodeSqlite.DatabaseSync(NodePath.join(dir, "state.sqlite"), {
      readOnly: true,
    })
      .prepare("select thread_id, adapter_key from provider_session_runtime order by thread_id")
      .all();
    expect(runtimeKeys.map((row) => row.adapter_key)).toEqual([
      "claude-lhc",
      "claude-lhc",
      "claudeAgent",
      "codex",
      "claudeAgent",
    ]);

    const again = run(dir, "--apply");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already migrated; nothing to do");
  });

  it("refuses an instance on an unexpected driver", () => {
    const dir = makeUserdata();
    const path = NodePath.join(dir, "settings.json");
    const settings = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    settings.providerInstances["claude-lhc"].driver = "codex";
    NodeFS.writeFileSync(path, JSON.stringify(settings));
    expect(run(dir, "--apply").status).toBe(2);
  });
});
