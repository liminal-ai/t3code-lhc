/**
 * `t3 thread import` — offline import of an LHC thread shell into t3code.
 *
 * Creates the deterministic t3code thread on the claude-lhc provider instance,
 * optionally backfills the raw history from a *copy* of the source LHC thread
 * database (`--source-db`, see `lhcHistory.ts` for the mapping), and records
 * the stopped provider session runtime row that lets the next real turn resume
 * through the sidecar with `--resume-session-id`.
 *
 * Write path is the offline orchestration engine only (same layer stack as
 * `t3 project`): validated commands, event store, projection pipeline, all in
 * process over the target userdata. There is deliberately no live HTTP fallback
 * and no direct event SQL. The command refuses while the server that owns the
 * userdata is running.
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { type LhcHistoryReport, planLhcHistory } from "./lhcHistory.ts";
import { deriveImportedThreadId } from "./lhcImportIds.ts";
import {
  type LhcSourceThread,
  LhcSourceReadError,
  readLhcThreadSource,
} from "./lhcThreadSource.ts";

export { deriveImportedThreadId, uuidV5 } from "./lhcImportIds.ts";

/** Provider driver that owns claude-lhc sessions; matches live claude-lhc runtime rows. */
const CLAUDE_PROVIDER_NAME = "claudeAgent";
const DEFAULT_PROVIDER_INSTANCE_ID = "claude-lhc";

const ImportCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  Layer.mergeAll(OrchestrationLayerLive, ProviderSessionRuntime.layer).pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

export class ImportThreadServerLiveError extends Schema.TaggedErrorClass<ImportThreadServerLiveError>()(
  "ImportThreadServerLiveError",
  {
    operation: Schema.Literal("refuseLiveServer"),
    statePath: Schema.String,
    pid: Schema.Int,
    origin: Schema.String,
  },
) {
  override get message(): string {
    return `A t3code server (pid ${this.pid}, ${this.origin}) is running against this userdata. Stop it before importing.`;
  }
}

export class ImportThreadInputError extends Schema.TaggedErrorClass<ImportThreadInputError>()(
  "ImportThreadInputError",
  {
    operation: Schema.Literal("validateImportInput"),
    field: Schema.String,
    value: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid value for ${this.field}: '${this.value}'.`;
  }
}

export class ImportThreadSourceError extends Schema.TaggedErrorClass<ImportThreadSourceError>()(
  "ImportThreadSourceError",
  {
    operation: Schema.Literal("readSource"),
    path: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot use LHC thread copy at ${this.path}: ${this.detail}`;
  }
}

/**
 * Read the copied LHC thread database and check it is the thread the caller
 * named. The live LHC record is never opened: the path must be a copy.
 */
const readImportSource = (path: string, sourceThreadId: string) =>
  Effect.try({
    try: () => readLhcThreadSource(path),
    catch: (cause) =>
      new ImportThreadSourceError({
        operation: "readSource",
        path,
        detail: cause instanceof LhcSourceReadError ? cause.detail : String(cause),
      }),
  }).pipe(
    Effect.flatMap((source) =>
      source.threadId === sourceThreadId
        ? Effect.succeed(source)
        : Effect.fail(
            new ImportThreadSourceError({
              operation: "readSource",
              path,
              detail: `thread id '${source.threadId}' does not match --source-thread-id '${sourceThreadId}'`,
            }),
          ),
    ),
  );

const requireTrimmed = (field: string, value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0
    ? Effect.succeed(trimmed)
    : Effect.fail(new ImportThreadInputError({ operation: "validateImportInput", field, value }));
};

const decodeProviderInstanceIdUnknown = Schema.decodeUnknownEffect(ProviderInstanceId);

const decodeProviderInstanceId = (value: string) =>
  decodeProviderInstanceIdUnknown(value.trim()).pipe(
    Effect.mapError(
      () =>
        new ImportThreadInputError({
          operation: "validateImportInput",
          field: "--instance",
          value,
        }),
    ),
  );

/**
 * Refuse while the server owning this userdata is alive. A stale state file
 * whose pid is gone does not block the import; it is logged and left in place.
 */
const refuseLiveServer = Effect.fn("refuseLiveServer")(function* (statePath: string) {
  const runtimeState = yield* readPersistedServerRuntimeState(statePath);
  if (Option.isNone(runtimeState)) {
    return;
  }
  if (isProcessAlive(runtimeState.value.pid)) {
    return yield* new ImportThreadServerLiveError({
      operation: "refuseLiveServer",
      statePath,
      pid: runtimeState.value.pid,
      origin: runtimeState.value.origin,
    });
  }
  yield* Effect.logWarning("Ignoring stale server runtime state; its pid is not running.", {
    statePath,
    pid: runtimeState.value.pid,
  });
});

export interface ImportThreadShellInput {
  readonly sourceThreadId: string;
  readonly resumeSessionId: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly runtimeMode: RuntimeMode;
  /** Used only when no source copy is supplied; otherwise counted from folded turns. */
  readonly turnCount: number;
  /** Raw history of the copied source thread; omitted for a shell-only import. */
  readonly source?: LhcSourceThread;
}

export interface ImportThreadResult {
  readonly threadId: ThreadId;
  readonly turnCount: number;
  readonly history: LhcHistoryReport | null;
}

/**
 * Create the thread shell through the engine, replay the source history as
 * validated commands, then record the stopped runtime row whose `turnCount`
 * reflects the folded turns. Runs inside the offline runtime layer; no
 * provider is started.
 */
export const importThreadShell = Effect.fn("importThreadShell")(function* (
  input: ImportThreadShellInput,
) {
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const threadId = deriveImportedThreadId(input.sourceThreadId);
  const createdAt = DateTime.formatIso(yield* DateTime.now);

  yield* orchestrationEngine.dispatch({
    type: "thread.create",
    // Receipts dedupe by command id, so the command id is fresh per run; the
    // thread id is what carries idempotency.
    commandId: CommandId.make(`server:thread-import:${NodeCrypto.randomUUID()}`),
    threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: { instanceId: input.instanceId, model: input.model },
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    branch: input.branch,
    worktreePath: input.worktreePath,
    createdAt,
  });

  let history: LhcHistoryReport | null = null;
  let turnCount = input.turnCount;
  if (input.source !== undefined) {
    const plan = planLhcHistory({
      source: input.source,
      sourceThreadId: input.sourceThreadId,
      threadId,
      providerName: CLAUDE_PROVIDER_NAME,
      providerInstanceId: input.instanceId,
      runtimeMode: input.runtimeMode,
    });
    // Sequential: each command's decider reads the read model the previous one produced.
    for (const command of plan.commands) {
      yield* orchestrationEngine.dispatch(command);
    }
    history = plan.report;
    turnCount = plan.report.turnCount;
  }

  yield* runtimeRepository.upsert({
    threadId,
    providerName: CLAUDE_PROVIDER_NAME,
    providerInstanceId: input.instanceId,
    adapterKey: CLAUDE_PROVIDER_NAME,
    runtimeMode: input.runtimeMode,
    status: "stopped",
    lastSeenAt: createdAt,
    resumeCursor: {
      threadId,
      resume: input.resumeSessionId,
      turnCount,
    },
    runtimePayload: { cwd: input.cwd, model: input.model },
  });

  return { threadId, turnCount, history };
});

/** Human-readable report lines for the history backfill; nothing is dropped silently. */
export function describeHistoryReport(report: LhcHistoryReport): ReadonlyArray<string> {
  const lines = [
    `Backfilled ${report.userMessages} user + ${report.assistantMessages} assistant messages, ${report.toolActivities} tool and ${report.noteActivities} note activities across ${report.turnCount} turns${report.interruptedTail ? " (last turn interrupted)" : ""}.`,
  ];
  for (const block of report.unsupportedBlocks) {
    lines.push(
      `Unsupported block kept as text: ${block.kind} ${block.sourceMessageId} → ${block.description}`,
    );
  }
  for (const call of report.danglingToolCalls) {
    lines.push(
      `Tool call without result closed as failed: ${call.toolName} ${call.toolCallId} (${call.sourceMessageId})`,
    );
  }
  for (const result of report.orphanToolResults) {
    lines.push(
      `Tool result without call recorded: ${result.toolCallId} (${result.sourceMessageId})`,
    );
  }
  for (const entry of report.skipped) {
    lines.push(`Skipped ${entry.kind} ${entry.sourceMessageId}: ${entry.reason}`);
  }
  return lines;
}

const threadImportCommand = Command.make("import", {
  ...projectLocationFlags,
  sourceThreadId: Flag.string("source-thread-id").pipe(
    Flag.withDescription("Source LHC thread id (identity only; derives the t3code thread id)."),
  ),
  resumeSessionId: Flag.string("resume-session-id").pipe(
    Flag.withDescription(
      "Session id registered by the LHC adopt step; stored as the resume cursor.",
    ),
  ),
  project: Flag.string("project").pipe(Flag.withDescription("Target t3code project id.")),
  title: Flag.string("title").pipe(Flag.withDescription("Thread title.")),
  model: Flag.string("model").pipe(
    Flag.withDescription("Model id for the thread's model selection."),
  ),
  instance: Flag.string("instance").pipe(
    Flag.withDescription("Provider instance id that owns the thread."),
    Flag.withDefault(DEFAULT_PROVIDER_INSTANCE_ID),
  ),
  cwd: Flag.string("cwd").pipe(Flag.withDescription("Working directory for provider sessions.")),
  worktreePath: Flag.string("worktree-path").pipe(
    Flag.withDescription("Worktree path recorded on the thread (defaults to none)."),
    Flag.optional,
  ),
  branch: Flag.string("branch").pipe(
    Flag.withDescription("Branch recorded on the thread (defaults to none)."),
    Flag.optional,
  ),
  runtimeMode: Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
    Flag.withDescription("Runtime mode for the thread."),
    Flag.withDefault("full-access" as RuntimeMode),
  ),
  turnCount: Flag.integer("turn-count").pipe(
    Flag.withDescription(
      "Turn count for the resume cursor when no --source-db is given; with a source it is counted from folded turns.",
    ),
    Flag.withDefault(0),
  ),
  sourceDb: Flag.string("source-db").pipe(
    Flag.withDescription(
      "Path to a COPY of the source LHC thread database (SQLite backup/VACUUM copy). Its raw history is backfilled; the live record is never opened.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Import an LHC thread shell into this userdata offline. Refuses while the server is running.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);

      const sourceThreadId = yield* requireTrimmed("--source-thread-id", flags.sourceThreadId);
      const resumeSessionId = yield* requireTrimmed("--resume-session-id", flags.resumeSessionId);
      const projectId = ProjectId.make(yield* requireTrimmed("--project", flags.project));
      const title = yield* requireTrimmed("--title", flags.title);
      const model = yield* requireTrimmed("--model", flags.model);
      const cwd = yield* requireTrimmed("--cwd", flags.cwd);
      const instanceId = yield* decodeProviderInstanceId(flags.instance);
      if (flags.turnCount < 0) {
        return yield* new ImportThreadInputError({
          operation: "validateImportInput",
          field: "--turn-count",
          value: String(flags.turnCount),
        });
      }
      const optionalTrimmed = (value: Option.Option<string>) => {
        const trimmed = Option.getOrUndefined(value)?.trim();
        return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
      };

      const sourceDb = optionalTrimmed(flags.sourceDb);
      const source =
        sourceDb === null ? undefined : yield* readImportSource(sourceDb, sourceThreadId);

      yield* refuseLiveServer(config.serverRuntimeStatePath);

      const offlineRuntimeLayer = ImportCliRuntimeLive.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      );

      const imported = yield* importThreadShell({
        sourceThreadId,
        resumeSessionId,
        projectId,
        title,
        instanceId,
        model,
        cwd,
        worktreePath: optionalTrimmed(flags.worktreePath),
        branch: optionalTrimmed(flags.branch),
        runtimeMode: flags.runtimeMode,
        turnCount: flags.turnCount,
        ...(source === undefined ? {} : { source }),
      }).pipe(Effect.provide(offlineRuntimeLayer));

      if (imported.history !== null) {
        for (const line of describeHistoryReport(imported.history)) {
          yield* Console.log(line);
        }
      }
      yield* Console.log(
        `Imported thread ${imported.threadId} (${title}) from LHC thread ${sourceThreadId} on ${instanceId}; resume session ${resumeSessionId}, ${imported.turnCount} turns.`,
      );
    }),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([threadImportCommand]),
);
