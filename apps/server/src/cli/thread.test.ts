// @effect-diagnostics nodeBuiltinImport:off - CLI integration test builds scratch userdata on the real filesystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { cli } from "../bin.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { deriveImportedThreadId, ImportThreadServerLiveError, uuidV5 } from "./thread.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

/** Run the real CLI entrypoint and return its last console line. */
const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    const lines = yield* TestConsole.logLines;
    return lines.findLast((line): line is string => typeof line === "string") ?? "";
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer)));

const makeScratchBaseDir = (label: string) =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-cli-thread-import-${label}-`));

const makeConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Error",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      desktopTelemetryFd: undefined,
      desktopTelemetryControlFd: undefined,
      resourceMonitorPath: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfig.ServerConfig["Service"];
  }).pipe(Effect.provide(NodeServices.layer));

/** Same persistence stack the CLI uses, opened read-mostly for assertions. */
const withScratchPersistence = <A, E>(
  baseDir: string,
  run: Effect.Effect<
    A,
    E,
    | OrchestrationEngine.OrchestrationEngineService
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
    | ProviderSessionRuntime.ProviderSessionRuntimeRepository
    | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const config = yield* makeConfig(baseDir);
    const layer = Layer.mergeAll(
      Layer.mergeAll(OrchestrationLayerLive, ProviderSessionRuntime.layer).pipe(
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(SqlitePersistenceLayerLive),
      ),
      WorkspacePaths.layer,
    ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provide(ServerConfig.layer(config)));
    return yield* run.pipe(Effect.provide(layer));
  });

const addProject = (baseDir: string) =>
  Effect.gen(function* () {
    const workspaceRoot = makeScratchBaseDir("workspace");
    yield* runCli([
      "project",
      "add",
      workspaceRoot,
      "--title",
      "Import Target",
      "--base-dir",
      baseDir,
    ]);
    const snapshot = yield* withScratchPersistence(
      baseDir,
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        return yield* query.getCommandReadModel();
      }),
    );
    const project = snapshot.projects.find(
      (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.deletedAt === null,
    );
    assert.isDefined(project);
    return { projectId: project.id, workspaceRoot };
  });

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeRuntimeState = Schema.encodeSync(Schema.fromJsonString(PersistedServerRuntimeState));

const SOURCE_THREAD_ID = "th_7d75762e6e311944";
const RESUME_SESSION_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";

const importArgs = (baseDir: string, projectId: string, workspaceRoot: string) => [
  "thread",
  "import",
  "--source-thread-id",
  SOURCE_THREAD_ID,
  "--resume-session-id",
  RESUME_SESSION_ID,
  "--project",
  projectId,
  "--title",
  "Wren (imported)",
  "--model",
  "claude-fable-5-1",
  "--cwd",
  workspaceRoot,
  "--worktree-path",
  workspaceRoot,
  "--branch",
  "main",
  "--turn-count",
  "27",
  "--base-dir",
  baseDir,
];

/** Fail loudly if anything in the import path reaches for the network. */
const withNetworkGuard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const calls: Array<string> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: unknown) => {
        calls.push(String(input));
        throw new Error("network access during offline import");
      }) as unknown as typeof fetch;
      return { calls, originalFetch };
    }),
    (guard) => effect.pipe(Effect.map((result) => ({ result, fetchCalls: guard.calls }))),
    (guard) =>
      Effect.sync(() => {
        globalThis.fetch = guard.originalFetch;
      }),
  );

describe("uuidV5", () => {
  it("matches the RFC 4122 example vector", () => {
    // uuid5(NAMESPACE_DNS, "www.example.com"), cross-checked with Python uuid.uuid5.
    assert.strictEqual(
      uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("derives a stable imported thread id per source thread", () => {
    const first = deriveImportedThreadId(SOURCE_THREAD_ID);
    assert.strictEqual(first, deriveImportedThreadId(SOURCE_THREAD_ID));
    assert.notStrictEqual(first, deriveImportedThreadId("th_other"));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("t3 thread import", () => {
  it.effect(
    "creates the deterministic thread shell and stopped runtime row offline, and refuses a second import",
    () =>
      Effect.gen(function* () {
        const baseDir = makeScratchBaseDir("offline");
        const { projectId, workspaceRoot } = yield* addProject(baseDir);
        const expectedThreadId = deriveImportedThreadId(SOURCE_THREAD_ID);

        const { result: output, fetchCalls } = yield* withNetworkGuard(
          runCli(importArgs(baseDir, projectId, workspaceRoot)),
        );
        assert.deepStrictEqual(fetchCalls, []);
        assert.include(output, `Imported thread ${expectedThreadId}`);
        assert.include(output, SOURCE_THREAD_ID);

        const after = yield* withScratchPersistence(
          baseDir,
          Effect.gen(function* () {
            const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
            const engine = yield* OrchestrationEngine.OrchestrationEngineService;
            const runtime = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
            const sql = yield* SqlClient.SqlClient;
            const snapshot = yield* query.getCommandReadModel();
            const thread = snapshot.threads.find((candidate) => candidate.id === expectedThreadId);
            const runtimeRow = yield* runtime.getByThreadId({ threadId: expectedThreadId });
            const projectionRows = yield* sql<{
              readonly thread_id: string;
              readonly project_id: string;
              readonly title: string;
              readonly branch: string | null;
              readonly worktree_path: string | null;
              readonly model_selection_json: string;
              readonly runtime_mode: string;
              readonly interaction_mode: string;
              readonly deleted_at: string | null;
              readonly latest_turn_id: string | null;
            }>`SELECT thread_id, project_id, title, branch, worktree_path, model_selection_json,
                      runtime_mode, interaction_mode, deleted_at, latest_turn_id
                 FROM projection_threads WHERE thread_id = ${expectedThreadId}`;
            const eventRows = yield* sql<{ readonly event_type: string }>`
              SELECT event_type FROM orchestration_events
               WHERE stream_id = ${expectedThreadId} ORDER BY sequence`;
            const sessionRows = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM projection_thread_sessions WHERE thread_id = ${expectedThreadId}`;
            const latestSequence = yield* engine.latestSequence;
            return { thread, runtimeRow, projectionRows, eventRows, sessionRows, latestSequence };
          }),
        );

        // Command read model: the thread exists on the claude-lhc instance with the given shell.
        assert.isDefined(after.thread);
        assert.strictEqual(after.thread.projectId, projectId);
        assert.strictEqual(after.thread.title, "Wren (imported)");
        assert.strictEqual(after.thread.modelSelection.instanceId, "claude-lhc");
        assert.strictEqual(after.thread.modelSelection.model, "claude-fable-5-1");
        assert.strictEqual(after.thread.branch, "main");
        assert.strictEqual(after.thread.worktreePath, workspaceRoot);
        assert.strictEqual(after.thread.runtimeMode, "full-access");
        assert.strictEqual(after.thread.session, null);
        assert.strictEqual(after.thread.latestTurn, null);
        assert.strictEqual(after.thread.deletedAt, null);

        // Projection row written by the pipeline, not by hand.
        assert.strictEqual(after.projectionRows.length, 1);
        const row = after.projectionRows[0]!;
        assert.strictEqual(row.project_id, projectId);
        assert.strictEqual(row.title, "Wren (imported)");
        assert.strictEqual(row.branch, "main");
        assert.strictEqual(row.worktree_path, workspaceRoot);
        assert.deepStrictEqual(decodeJson(row.model_selection_json), {
          instanceId: "claude-lhc",
          model: "claude-fable-5-1",
        });
        assert.strictEqual(row.runtime_mode, "full-access");
        assert.strictEqual(row.interaction_mode, "default");
        assert.strictEqual(row.deleted_at, null);
        assert.strictEqual(row.latest_turn_id, null);

        // Exactly one event for the thread, and no session was ever set: no provider ran.
        assert.deepStrictEqual(
          after.eventRows.map((event) => event.event_type),
          ["thread.created"],
        );
        assert.strictEqual(Number(after.sessionRows[0]!.n), 0);

        // Stopped runtime row with the resume cursor the sidecar will consume.
        assert.isTrue(Option.isSome(after.runtimeRow));
        const runtimeRow = Option.getOrThrow(after.runtimeRow);
        assert.strictEqual(runtimeRow.providerName, "claudeAgent");
        assert.strictEqual(runtimeRow.adapterKey, "claudeAgent");
        assert.strictEqual(runtimeRow.providerInstanceId, "claude-lhc");
        assert.strictEqual(runtimeRow.runtimeMode, "full-access");
        assert.strictEqual(runtimeRow.status, "stopped");
        assert.deepStrictEqual(runtimeRow.resumeCursor, {
          threadId: expectedThreadId,
          resume: RESUME_SESSION_ID,
          turnCount: 27,
        });
        assert.deepStrictEqual(runtimeRow.runtimePayload, {
          cwd: workspaceRoot,
          model: "claude-fable-5-1",
        });

        // Second import of the same source thread refuses through the engine and changes nothing.
        const secondRun = yield* runCli(importArgs(baseDir, projectId, workspaceRoot)).pipe(
          Effect.flip,
        );
        assert.include(String(secondRun), "thread.create");
        const afterSecond = yield* withScratchPersistence(
          baseDir,
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngine.OrchestrationEngineService;
            const runtime = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM projection_threads WHERE thread_id = ${expectedThreadId}`;
            return {
              latestSequence: yield* engine.latestSequence,
              runtimeRow: yield* runtime.getByThreadId({ threadId: expectedThreadId }),
              threadRows: Number(rows[0]!.n),
            };
          }),
        );
        assert.strictEqual(afterSecond.latestSequence, after.latestSequence);
        assert.strictEqual(afterSecond.threadRows, 1);
        assert.deepStrictEqual(
          Option.getOrThrow(afterSecond.runtimeRow).resumeCursor,
          runtimeRow.resumeCursor,
        );
      }),
    { timeout: 30_000 },
  );

  it.effect("refuses while the server owning the userdata is alive, and writes nothing", () =>
    Effect.gen(function* () {
      const baseDir = makeScratchBaseDir("live");
      const { projectId, workspaceRoot } = yield* addProject(baseDir);
      const config = yield* makeConfig(baseDir);
      NodeFS.writeFileSync(
        config.serverRuntimeStatePath,
        encodeRuntimeState({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );

      const error = yield* runCli(importArgs(baseDir, projectId, workspaceRoot)).pipe(Effect.flip);
      assert.instanceOf(error, ImportThreadServerLiveError);
      assert.strictEqual(error.pid, process.pid);
      assert.include(error.message, "Stop it before importing");

      const state = yield* withScratchPersistence(
        baseDir,
        Effect.gen(function* () {
          const runtime = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS n FROM projection_threads`;
          return {
            threadRows: Number(rows[0]!.n),
            runtimeRow: yield* runtime.getByThreadId({
              threadId: deriveImportedThreadId(SOURCE_THREAD_ID),
            }),
          };
        }),
      );
      assert.strictEqual(state.threadRows, 0);
      assert.isTrue(Option.isNone(state.runtimeRow));
      // The state file is left for its owner; this command never clears it.
      assert.isTrue(NodeFS.existsSync(config.serverRuntimeStatePath));
    }),
  );

  it.effect("ignores a stale runtime state whose pid is gone", () =>
    Effect.gen(function* () {
      const baseDir = makeScratchBaseDir("stale");
      const { projectId, workspaceRoot } = yield* addProject(baseDir);
      const config = yield* makeConfig(baseDir);
      // pid_max on Linux is at most 2^22; this pid cannot be running.
      NodeFS.writeFileSync(
        config.serverRuntimeStatePath,
        encodeRuntimeState({
          version: 1,
          pid: 4_194_303,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: DateTime.formatIso(yield* DateTime.now),
        }),
      );

      yield* runCli(importArgs(baseDir, projectId, workspaceRoot));
      const rows = yield* withScratchPersistence(
        baseDir,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM projection_threads`;
        }),
      );
      assert.deepStrictEqual(
        rows.map((row) => row.thread_id),
        [ThreadId.make(deriveImportedThreadId(SOURCE_THREAD_ID))],
      );
    }),
  );

  it.effect("rejects an unknown project through the engine before touching the runtime row", () =>
    Effect.gen(function* () {
      const baseDir = makeScratchBaseDir("no-project");
      const workspaceRoot = makeScratchBaseDir("workspace");
      const error = yield* runCli(
        importArgs(baseDir, "project-does-not-exist", workspaceRoot),
      ).pipe(Effect.flip);
      assert.include(String(error), "thread.create");
      const runtimeRow = yield* withScratchPersistence(
        baseDir,
        Effect.gen(function* () {
          const runtime = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          return yield* runtime.getByThreadId({
            threadId: deriveImportedThreadId(SOURCE_THREAD_ID),
          });
        }),
      );
      assert.isTrue(Option.isNone(runtimeRow));
    }),
  );
});
