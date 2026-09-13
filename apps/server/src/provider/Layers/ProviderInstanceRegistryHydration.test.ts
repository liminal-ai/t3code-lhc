import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { deepMerge } from "@t3tools/shared/Struct";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { FORK_INSTANCE_SEEDS } from "../forkInstanceSeed.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as CodexResetCredit from "./codexResetCredit.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";

const decodeServerSettings = Schema.decodeSync(ContractServerSettings);
const encodeServerSettings = Schema.encodeSync(ContractServerSettings);
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeMutableServerSettingsService = (initial: ContractServerSettings) =>
  Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();
    const writes = yield* Ref.make(0);
    const service = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const next = applyServerSettingsPatch(yield* Ref.get(settingsRef), patch);
          encodeServerSettings(next);
          yield* Ref.set(settingsRef, next);
          yield* Ref.update(writes, (n) => n + 1);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        );
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
    return { ...service, settingsRef, writes };
  });

// Every stock provider disabled so nothing on the host is probed; the seeded
// rows point at scratch scripts that exit immediately.
const quietSettings = decodeServerSettings(
  deepMerge(encodeServerSettings(DEFAULT_SERVER_SETTINGS), {
    providers: {
      codex: { enabled: false },
      claudeAgent: { enabled: false },
      cursor: { enabled: false },
      grok: { enabled: false },
      opencode: { enabled: false },
    },
  }),
);

describe("ProviderInstanceRegistryHydration fork seeds", () => {
  // live clock: the reconcile watcher runs on real fibers and the poll below sleeps
  it.live(
    "persists codex-lhc at boot and grok-lhc after a settings change once its binary appears, each once",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const dir = yield* fileSystem.makeTempDirectoryScoped({
          directory: expandHomePath("~"),
          prefix: ".t3-hydration-seed-",
        });
        const binDir = path.join(dir, "bin");
        yield* fileSystem.makeDirectory(binDir);
        const writeScript = Effect.fn(function* (name: string) {
          const file = path.join(binDir, platform === "win32" ? `${name}.cmd` : name);
          yield* fileSystem.writeFileString(
            file,
            platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
          );
          if (platform !== "win32") yield* fileSystem.chmod(file, 0o755);
        });
        yield* writeScript("codex-lhc");

        const serverSettings = yield* makeMutableServerSettingsService(quietSettings);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.build(
          ProviderInstanceRegistryHydrationLive.pipe(
            Layer.provideMerge(AntigravityInstallation.layer),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-hydration-seed-" }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(CodexResetCredit.layerTest),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
            Layer.provideMerge(
              Layer.succeed(HostProcessEnvironment, {
                ...process.env,
                PATH: binDir,
                // the host may point at a real sidecar; this test owns availability
                CLAUDE_LHC_SIDECAR: path.join(dir, "no-sidecar.js"),
              }),
            ),
            Layer.provideMerge(Layer.succeed(CommandResolutionCache, new Map())),
            Layer.provideMerge(NodeServices.layer),
          ),
        ).pipe(Scope.provide(scope));

        yield* Effect.gen(function* () {
          const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
          const ids = () =>
            registry.listInstances.pipe(
              Effect.map((instances) =>
                instances.map((instance) => instance.instanceId).toSorted(),
              ),
            );
          const booted = yield* ids();
          assert.include(booted, ProviderInstanceId.make("codex-lhc"));
          assert.notInclude(booted, ProviderInstanceId.make("grok-lhc"));
          assert.notInclude(booted, ProviderInstanceId.make("claude-lhc"));
          const codexLhc = yield* registry.getInstance(ProviderInstanceId.make("codex-lhc"));
          assert.equal(codexLhc?.driverKind, "codex");
          assert.equal(codexLhc?.displayName, "Codex LHC");
          // the row was written into settings, once, with the seed values; nothing else
          const bootSettings = yield* Ref.get(serverSettings.settingsRef);
          assert.deepEqual(
            bootSettings.providerInstances[ProviderInstanceId.make("codex-lhc")],
            FORK_INSTANCE_SEEDS["codex-lhc"],
          );
          assert.deepEqual(Object.keys(bootSettings.providerInstances), ["codex-lhc"]);
          assert.equal(yield* Ref.get(serverSettings.writes), 1);

          // A fork binary installed later shows up on the next settings change.
          yield* writeScript("grok-lhc");
          yield* serverSettings.updateSettings({ sidebarAutoSettleAfterDays: 3 });
          const grokLhcId = ProviderInstanceId.make("grok-lhc");
          let afterChange = yield* ids();
          for (let attempt = 0; attempt < 200 && !afterChange.includes(grokLhcId); attempt++) {
            yield* Effect.sleep("25 millis");
            afterChange = yield* ids();
          }
          assert.include(afterChange, grokLhcId);
          // the benign change plus exactly one seed write; the seed write's own
          // change emission reached the watcher with the row present and wrote nothing
          let writes = yield* Ref.get(serverSettings.writes);
          for (let attempt = 0; attempt < 40 && writes < 3; attempt++) {
            yield* Effect.sleep("25 millis");
            writes = yield* Ref.get(serverSettings.writes);
          }
          yield* Effect.sleep("200 millis");
          assert.equal(yield* Ref.get(serverSettings.writes), 3);
          const later = yield* Ref.get(serverSettings.settingsRef);
          assert.deepEqual(later.providerInstances[grokLhcId], FORK_INSTANCE_SEEDS["grok-lhc"]);
          assert.deepEqual(
            later.providerInstances[ProviderInstanceId.make("codex-lhc")],
            FORK_INSTANCE_SEEDS["codex-lhc"],
          );

          // an existing row that differs from the seed is left alone and triggers no write
          yield* serverSettings.updateSettings({
            providerInstances: {
              ...later.providerInstances,
              [ProviderInstanceId.make("codex-lhc")]: {
                driver: ProviderDriverKind.make("codex"),
                config: { binaryPath: "/opt/codex" },
              },
            },
          });
          yield* Effect.sleep("300 millis");
          assert.equal(yield* Ref.get(serverSettings.writes), 4);
          assert.deepEqual(
            (yield* Ref.get(serverSettings.settingsRef)).providerInstances[
              ProviderInstanceId.make("codex-lhc")
            ]?.config,
            { binaryPath: "/opt/codex" },
          );
        }).pipe(Effect.provide(services));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
