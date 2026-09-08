/**
 * `t3 thread import` — offline import of an LHC thread shell into t3code.
 *
 * Slice 1 of the LHC import: creates the deterministic t3code thread on the
 * claude-lhc provider instance and records the stopped provider session runtime
 * row that lets the next real turn resume through the sidecar with
 * `--resume-session-id`. Raw history backfill is a later slice.
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
  ThreadId,
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

/** Provider driver that owns claude-lhc sessions; matches live claude-lhc runtime rows. */
const CLAUDE_PROVIDER_NAME = "claudeAgent";
const DEFAULT_PROVIDER_INSTANCE_ID = "claude-lhc";

/**
 * Fixed UUID v5 namespace for imported thread identities. Changing it changes
 * every derived thread id, so it is a constant, not configuration.
 */
const IMPORTED_THREAD_NAMESPACE = "9c3f2d54-6b1e-4f8a-9a5c-2e7d1b0c8f43";

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

const uuidBytes = (uuid: string): Uint8Array => Buffer.from(uuid.replace(/-/g, ""), "hex");

const formatUuid = (bytes: Uint8Array): string => {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** RFC 4122 UUID v5 (SHA-1) over `namespace` and `name`. */
export function uuidV5(namespace: string, name: string): string {
  const hash = NodeCrypto.createHash("sha1")
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * Deterministic t3code thread id for a source LHC thread: UUID v5 over
 * `cc-lhc:<source thread id>`. Importing the same source twice derives the
 * same id, and the engine's thread-absence invariant refuses the second run.
 */
export function deriveImportedThreadId(sourceThreadId: string): ThreadId {
  return ThreadId.make(uuidV5(IMPORTED_THREAD_NAMESPACE, `cc-lhc:${sourceThreadId}`));
}

const ImportCliRuntimeLive = Layer.mergeAll(
  WorkspacePaths.layer,
  Layer.mergeAll(OrchestrationLayerLive, ProviderSessionRuntime.layer).pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
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
  readonly turnCount: number;
}

/**
 * Create the thread shell through the engine, then record the stopped runtime
 * row. Runs inside the offline runtime layer; no provider is started.
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
      turnCount: input.turnCount,
    },
    runtimePayload: { cwd: input.cwd, model: input.model },
  });

  return threadId;
});

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
      "Closed prompted turns after segment folding; stored on the resume cursor.",
    ),
    Flag.withDefault(0),
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

      yield* refuseLiveServer(config.serverRuntimeStatePath);

      const offlineRuntimeLayer = ImportCliRuntimeLive.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      );

      const threadId = yield* importThreadShell({
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
      }).pipe(Effect.provide(offlineRuntimeLayer));

      yield* Console.log(
        `Imported thread ${threadId} (${title}) from LHC thread ${sourceThreadId} on ${instanceId}; resume session ${resumeSessionId}, ${flags.turnCount} turns.`,
      );
    }),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage threads."),
  Command.withSubcommands([threadImportCommand]),
);
