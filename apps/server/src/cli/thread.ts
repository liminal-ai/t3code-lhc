/**
 * `t3 thread import` — import an LHC thread into t3code, live or offline.
 *
 * Creates the deterministic t3code thread on the claude-lhc provider instance,
 * optionally backfills its raw history from an LHC export (`--history`, the
 * JSON `lhc thread export` writes; see `orchestration/lhcHistoryImport.ts` for
 * the mapping), and records the stopped provider session runtime row that lets
 * the next real turn resume through the sidecar with `--resume-session-id`.
 *
 * The whole import is one validated command, `thread.lhc-history.import`,
 * with or without history. While the server that owns the
 * userdata is running, the command goes to it over HTTP dispatch (same route
 * and token the project CLI uses) and lands in one transaction; otherwise the
 * offline orchestration engine runs it in process over the userdata. There is
 * no direct event SQL either way. The runtime row is written directly after a
 * successful dispatch, as the offline path always did: the session directory
 * reads it from SQLite on the next turn.
 */
import * as NodeCrypto from "node:crypto";

import {
  AuthAdministrativeScopes,
  type ClientOrchestrationCommand,
  CommandId,
  EnvironmentHttpApi,
  LhcHistoryExport,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { type LhcHistoryReport, planLhcHistory } from "../orchestration/lhcHistoryImport.ts";
import { deriveImportedThreadId } from "../orchestration/lhcImportIds.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export { deriveImportedThreadId, uuidV5 } from "../orchestration/lhcImportIds.ts";

/** Driver kind that owns claude-lhc sessions; matches live claude-lhc runtime rows. */
const CLAUDE_PROVIDER_NAME = "claude-lhc";
const DEFAULT_PROVIDER_INSTANCE_ID = "claude-lhc";
/** A full record is thousands of events in one transaction; give the server time. */
const LIVE_DISPATCH_TIMEOUT = Duration.seconds(120);

const ImportOfflineRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  Layer.mergeAll(OrchestrationLayerLive, ProviderSessionRuntime.layer).pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

/** Runtime row only: the persistence layer waits on the server's lock rather than failing. */
const ImportRuntimeRowLive = ProviderSessionRuntime.layer.pipe(
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

export class ImportThreadLiveDispatchError extends Schema.TaggedErrorClass<ImportThreadLiveDispatchError>()(
  "ImportThreadLiveDispatchError",
  {
    operation: Schema.Literal("dispatchLiveServer"),
    origin: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `The running t3code server at ${this.origin} did not accept the import: ${this.detail}`;
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
    operation: Schema.Literal("readHistory"),
    path: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot use LHC history export at ${this.path}: ${this.detail}`;
  }
}

const decodeHistoryExport = Schema.decodeUnknownEffect(Schema.fromJsonString(LhcHistoryExport));

/**
 * Read the exported history and check it is the thread the caller named. The
 * export is what `lhc thread export` wrote; the LHC record itself is never
 * opened here.
 */
const readHistoryExport = Effect.fn("readHistoryExport")(function* (
  path: string,
  sourceThreadId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const sourceError = (detail: string) =>
    new ImportThreadSourceError({ operation: "readHistory", path, detail });
  const text = yield* fileSystem
    .readFileString(path)
    .pipe(Effect.mapError((cause) => sourceError(cause.message)));
  const history = yield* decodeHistoryExport(text).pipe(
    Effect.mapError((cause) => sourceError(`not an LHC history export: ${cause.message}`)),
  );
  if (history.threadId !== sourceThreadId) {
    return yield* sourceError(
      `thread id '${history.threadId}' does not match --source-thread-id '${sourceThreadId}'`,
    );
  }
  return history;
});

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

export type ImportExecutionMode =
  | { readonly mode: "live"; readonly origin: string }
  | { readonly mode: "offline" };

/**
 * Live while the server owning this userdata is alive, offline otherwise. A
 * stale state file whose pid is gone is logged and left in place.
 */
const resolveImportMode = Effect.fn("resolveImportMode")(function* (statePath: string) {
  const runtimeState = yield* readPersistedServerRuntimeState(statePath);
  if (Option.isNone(runtimeState)) {
    return { mode: "offline" } satisfies ImportExecutionMode;
  }
  if (isProcessAlive(runtimeState.value.pid)) {
    return { mode: "live", origin: runtimeState.value.origin } satisfies ImportExecutionMode;
  }
  yield* Effect.logWarning("Ignoring stale server runtime state; its pid is not running.", {
    statePath,
    pid: runtimeState.value.pid,
  });
  return { mode: "offline" } satisfies ImportExecutionMode;
});

export interface ImportThreadInput {
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
  /** Used only when no history is supplied; otherwise counted from folded turns. */
  readonly turnCount: number;
  /** Exported raw history of the source thread; omitted for a shell-only import. */
  readonly history?: LhcHistoryExport;
}

/** The command an import dispatches; client-dispatchable and an engine command. */
export type ImportDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.lhc-history.import" }
>;

export interface ImportThreadCommandPlan {
  readonly threadId: ThreadId;
  readonly command: ImportDispatchCommand;
  readonly turnCount: number;
  readonly report: LhcHistoryReport | null;
}

/**
 * The one command an import dispatches: `thread.lhc-history.import` carrying
 * the whole export, or an empty export for a shell-only import. Pure apart
 * from the fresh command id; the thread id carries idempotency, so a second
 * import of the same source is refused by the engine's thread-absent check.
 */
export function planImportThreadCommand(
  input: ImportThreadInput,
  createdAt: string,
): ImportThreadCommandPlan {
  const threadId = deriveImportedThreadId(input.sourceThreadId);
  const history: LhcHistoryExport = input.history ?? {
    threadId: input.sourceThreadId,
    exportedAt: createdAt,
    turns: [],
    omitted: {},
  };
  // Same pure plan the decider runs, for the report and the turn count.
  const plan = planLhcHistory({
    history,
    sourceThreadId: input.sourceThreadId,
    threadId,
    providerName: CLAUDE_PROVIDER_NAME,
    providerInstanceId: input.instanceId,
    runtimeMode: input.runtimeMode,
  });
  return {
    threadId,
    turnCount: input.history === undefined ? input.turnCount : plan.report.turnCount,
    report: input.history === undefined ? null : plan.report,
    command: {
      type: "thread.lhc-history.import",
      commandId: CommandId.make(`server:thread-import:${NodeCrypto.randomUUID()}`),
      threadId,
      sourceThreadId: input.sourceThreadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: { instanceId: input.instanceId, model: input.model },
      runtimeMode: input.runtimeMode,
      branch: input.branch,
      worktreePath: input.worktreePath,
      providerName: CLAUDE_PROVIDER_NAME,
      history,
      createdAt,
    },
  };
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** One HTTP dispatch to the running server, with the same route the project CLI uses. */
const dispatchToLiveServer = (origin: string, token: string, command: ImportDispatchCommand) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    return yield* client.orchestration.dispatch({
      headers: { authorization: `Bearer ${token}` },
      payload: command,
    } as Parameters<typeof client.orchestration.dispatch>[0]);
  }).pipe(
    Effect.timeout(LIVE_DISPATCH_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new ImportThreadLiveDispatchError({
          operation: "dispatchLiveServer",
          origin,
          detail: describeCause(cause),
        }),
    ),
  );

const withImportSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthAdministrativeScopes,
      label: "t3 thread import",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

/** The stopped runtime row whose cursor the sidecar consumes on the next turn. */
const recordRuntimeRow = Effect.fn("recordRuntimeRow")(function* (
  input: ImportThreadInput,
  threadId: ThreadId,
  turnCount: number,
  lastSeenAt: string,
) {
  const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  yield* runtimeRepository.upsert({
    threadId,
    providerName: CLAUDE_PROVIDER_NAME,
    providerInstanceId: input.instanceId,
    adapterKey: CLAUDE_PROVIDER_NAME,
    runtimeMode: input.runtimeMode,
    status: "stopped",
    lastSeenAt,
    resumeCursor: {
      threadId,
      resume: input.resumeSessionId,
      turnCount,
    },
    runtimePayload: { cwd: input.cwd, model: input.model },
  });
});

/** Human-readable report lines for the history backfill; nothing is dropped silently. */
export function describeHistoryReport(report: LhcHistoryReport): ReadonlyArray<string> {
  const lines = [
    `Backfilled ${report.userMessages} user + ${report.assistantMessages} assistant messages, ${report.toolActivities} tool and ${report.noteActivities} note activities across ${report.turnCount} turns${report.interruptedTail ? " (last turn interrupted)" : ""}.`,
  ];
  const omitted = Object.entries(report.omitted)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([kind, count]) => `${kind} ${count}`);
  if (omitted.length > 0) {
    lines.push(`Kept in the LHC record only (not exported): ${omitted.join(", ")}.`);
  }
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
      "Session id bound by `lhc thread fork --host claude-lhc`; stored as the resume cursor.",
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
      "Turn count for the resume cursor when no --history is given; with a history it is counted from folded turns.",
    ),
    Flag.withDefault(0),
  ),
  history: Flag.string("history").pipe(
    Flag.withDescription(
      "Path to the JSON written by `lhc thread export` for the source thread. Its raw history is backfilled in the same command that creates the thread.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Import an LHC thread (shell, optionally with its exported history) into this userdata: through the running server when there is one, offline otherwise.",
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

      const historyPath = optionalTrimmed(flags.history);
      const history =
        historyPath === null ? undefined : yield* readHistoryExport(historyPath, sourceThreadId);

      const input: ImportThreadInput = {
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
        ...(history === undefined ? {} : { history }),
      };
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const planned = planImportThreadCommand(input, createdAt);
      const serverConfigLayer = Layer.mergeAll(
        ServerConfig.layer(config),
        Layer.succeed(References.MinimumLogLevel, config.logLevel),
      );

      const execution = yield* resolveImportMode(config.serverRuntimeStatePath);
      if (execution.mode === "live") {
        yield* Effect.gen(function* () {
          const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
          yield* withImportSessionToken(environmentAuth, (token) =>
            dispatchToLiveServer(execution.origin, token, planned.command),
          );
        }).pipe(
          Effect.provide(
            EnvironmentAuth.runtimeLayer.pipe(
              Layer.provideMerge(FetchHttpClient.layer),
              Layer.provide(serverConfigLayer),
            ),
          ),
        );
        yield* recordRuntimeRow(input, planned.threadId, planned.turnCount, createdAt).pipe(
          Effect.provide(ImportRuntimeRowLive.pipe(Layer.provide(serverConfigLayer))),
        );
      } else {
        yield* Effect.gen(function* () {
          const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
          yield* orchestrationEngine.dispatch(planned.command);
          yield* recordRuntimeRow(input, planned.threadId, planned.turnCount, createdAt);
        }).pipe(Effect.provide(ImportOfflineRuntimeLive.pipe(Layer.provide(serverConfigLayer))));
      }

      if (planned.report !== null) {
        for (const line of describeHistoryReport(planned.report)) {
          yield* Console.log(line);
        }
      }
      const via =
        execution.mode === "live" ? `via the running server at ${execution.origin}` : "offline";
      yield* Console.log(
        `Imported thread ${planned.threadId} (${title}) from LHC thread ${sourceThreadId} on ${instanceId} ${via}; resume session ${resumeSessionId}, ${planned.turnCount} turns.`,
      );
    }),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([threadImportCommand]),
);
