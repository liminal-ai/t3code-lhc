import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import {
  FORK_INSTANCE_SEED_IDS,
  FORK_INSTANCE_SEEDS,
  missingForkInstanceSeeds,
  NO_FORK_INSTANCE_SEEDS,
  persistForkInstanceSeeds,
  resolveForkInstanceSeedAvailability,
} from "./forkInstanceSeed.ts";

const ALL_SEEDS = { "claude-lhc": true, "codex-lhc": true, "grok-lhc": true } as const;

/** In-memory settings service that counts writes; the patch path is the production one. */
const makeCountingSettingsService = (initial: ServerSettings) =>
  Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const writes = yield* Ref.make(0);
    const service = {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const next = applyServerSettingsPatch(yield* Ref.get(settingsRef), patch);
          yield* Ref.set(settingsRef, next);
          yield* Ref.update(writes, (n) => n + 1);
          return next;
        }),
      get streamChanges() {
        return Stream.empty;
      },
      get subscribeChanges() {
        return Effect.succeed(Stream.empty);
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
    return { service, settingsRef, writes };
  });

const withSettings = (providerInstances: Record<string, unknown>): ServerSettings =>
  ({ ...DEFAULT_SERVER_SETTINGS, providerInstances }) as unknown as ServerSettings;

describe("fork instance seed", () => {
  it("lists the available ids that are absent, in seed order, with the tabled values", () => {
    assert.deepEqual(missingForkInstanceSeeds({}, ALL_SEEDS), [
      "claude-lhc",
      "codex-lhc",
      "grok-lhc",
    ]);
    assert.deepEqual(missingForkInstanceSeeds({}, NO_FORK_INSTANCE_SEEDS), []);
    assert.deepEqual(
      missingForkInstanceSeeds({}, { "claude-lhc": true, "codex-lhc": false, "grok-lhc": true }),
      ["claude-lhc", "grok-lhc"],
    );
    assert.deepEqual(FORK_INSTANCE_SEEDS["claude-lhc"], {
      driver: ProviderDriverKind.make("claude-lhc"),
      displayName: "Claude LHC",
      accentColor: "#7c3aed",
      enabled: true,
      config: {},
    });
    assert.deepEqual(FORK_INSTANCE_SEEDS["codex-lhc"].config, {
      binaryPath: "codex-lhc",
      updateSource: "lhc",
    });
    assert.deepEqual(FORK_INSTANCE_SEEDS["grok-lhc"], {
      driver: ProviderDriverKind.make("grok"),
      displayName: "Grok LHC",
      accentColor: "#7c3aed",
      enabled: true,
      config: { binaryPath: "grok-lhc" },
    });
    assert.equal(FORK_INSTANCE_SEED_IDS.length, 3);
  });

  it("treats any existing row as present, whatever it says (explicit wins, never rewritten)", () => {
    const rows = {
      "codex-lhc": { driver: "codex", config: { binaryPath: "/opt/codex" } },
      "claude-lhc": { driver: "claudeAgent", enabled: false },
    };
    assert.deepEqual(missingForkInstanceSeeds(withSettings(rows).providerInstances, ALL_SEEDS), [
      "grok-lhc",
    ]);
  });

  it("no longer merges anything into deriveProviderInstanceConfigMap", () => {
    const stock = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    assert.deepEqual(
      Object.keys(stock).filter((id) => id.endsWith("-lhc")),
      [],
    );
  });

  it.effect("persists the missing rows once through the settings-update command", () =>
    Effect.gen(function* () {
      const explicitCodexLhc = {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/opt/codex" },
      };
      const { service, settingsRef, writes } = yield* makeCountingSettingsService(
        withSettings({ "codex-lhc": explicitCodexLhc }),
      );
      const run = (availability: typeof ALL_SEEDS | typeof NO_FORK_INSTANCE_SEEDS) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          return yield* persistForkInstanceSeeds(current, availability);
        }).pipe(Effect.provideService(ServerSettingsModule.ServerSettingsService, service));

      // nothing available: no write
      yield* run(NO_FORK_INSTANCE_SEEDS);
      assert.equal(yield* Ref.get(writes), 0);

      // claude-lhc and grok-lhc absent: one write with the full map plus both rows
      const after = yield* run(ALL_SEEDS);
      assert.equal(yield* Ref.get(writes), 1);
      assert.deepEqual(
        after.providerInstances[ProviderInstanceId.make("claude-lhc")],
        FORK_INSTANCE_SEEDS["claude-lhc"],
      );
      assert.deepEqual(
        after.providerInstances[ProviderInstanceId.make("grok-lhc")],
        FORK_INSTANCE_SEEDS["grok-lhc"],
      );
      // the explicit row that differs from the seed is byte-identical
      assert.deepEqual(
        after.providerInstances[ProviderInstanceId.make("codex-lhc")],
        explicitCodexLhc,
      );
      assert.deepEqual(yield* Ref.get(settingsRef), after);

      // second pass with the same availability: nothing to write, same settings returned
      const again = yield* run(ALL_SEEDS);
      assert.equal(yield* Ref.get(writes), 1);
      assert.deepEqual(again, after);
    }),
  );

  it.layer(NodeServices.layer)("availability probe", (it) => {
    it.effect("reports the sidecar file and the fork binaries on PATH, nothing else", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const isHostWindows = (yield* HostProcessPlatform) === "win32";
        // Under the home dir: a noexec /tmp fails the X_OK check the resolver uses.
        const dir = yield* fileSystem.makeTempDirectoryScoped({
          directory: expandHomePath("~"),
          prefix: ".t3-fork-seed-",
        });
        const binDir = path.join(dir, "bin");
        yield* fileSystem.makeDirectory(binDir);
        const codexLhc = path.join(binDir, isHostWindows ? "codex-lhc.cmd" : "codex-lhc");
        yield* fileSystem.writeFileString(
          codexLhc,
          isHostWindows ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n",
        );
        if (!isHostWindows) yield* fileSystem.chmod(codexLhc, 0o755);
        const sidecar = path.join(dir, "sidecar.js");
        yield* fileSystem.writeFileString(sidecar, "");

        const probe = (env: NodeJS.ProcessEnv) =>
          resolveForkInstanceSeedAvailability().pipe(
            Effect.provideService(HostProcessEnvironment, env),
            Effect.provideService(CommandResolutionCache, new Map()),
          );

        assert.deepEqual(yield* probe({ PATH: binDir, CLAUDE_LHC_SIDECAR: sidecar }), {
          "claude-lhc": true,
          "codex-lhc": true,
          "grok-lhc": false,
        });
        assert.deepEqual(yield* probe({ PATH: binDir }), {
          "claude-lhc": false,
          "codex-lhc": true,
          "grok-lhc": false,
        });
        assert.deepEqual(
          yield* probe({ PATH: dir, CLAUDE_LHC_SIDECAR: path.join(dir, "missing.js") }),
          NO_FORK_INSTANCE_SEEDS,
        );
      }).pipe(Effect.scoped),
    );
  });
});
