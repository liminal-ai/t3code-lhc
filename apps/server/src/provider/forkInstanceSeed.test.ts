import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstanceConfigMap,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "../pathExpansion.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import {
  FORK_INSTANCE_SEED_IDS,
  FORK_INSTANCE_SEEDS,
  NO_FORK_INSTANCE_SEEDS,
  resolveForkInstanceSeedAvailability,
  seedForkProviderInstances,
} from "./forkInstanceSeed.ts";

const ALL_SEEDS = { "claude-lhc": true, "codex-lhc": true, "grok-lhc": true } as const;

describe("fork instance seed", () => {
  it("seeds exactly the available ids with the tabled values", () => {
    const seeded = seedForkProviderInstances({} as ProviderInstanceConfigMap, {
      "claude-lhc": true,
      "codex-lhc": false,
      "grok-lhc": true,
    });
    assert.deepEqual(Object.keys(seeded).toSorted(), ["claude-lhc", "grok-lhc"]);
    assert.deepEqual(seeded[ProviderInstanceId.make("claude-lhc")], {
      driver: ProviderDriverKind.make("claude-lhc"),
      displayName: "Claude LHC",
      accentColor: "#7c3aed",
      enabled: true,
      config: {},
    });
    assert.deepEqual(seeded[ProviderInstanceId.make("grok-lhc")], {
      driver: ProviderDriverKind.make("grok"),
      displayName: "Grok LHC",
      accentColor: "#7c3aed",
      enabled: true,
      config: { binaryPath: "grok-lhc" },
    });
    assert.deepEqual(FORK_INSTANCE_SEEDS["codex-lhc"].config, {
      binaryPath: "codex-lhc",
      updateSource: "lhc",
    });
    assert.deepEqual(
      seedForkProviderInstances({} as ProviderInstanceConfigMap, NO_FORK_INSTANCE_SEEDS),
      {},
    );
    assert.equal(FORK_INSTANCE_SEED_IDS.length, 3);
  });

  it("never stomps an explicit entry with the same id", () => {
    const explicit = {
      "codex-lhc": {
        driver: ProviderDriverKind.make("codex"),
        config: { binaryPath: "/opt/codex" },
      },
      "claude-lhc": { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
    } as unknown as ProviderInstanceConfigMap;
    const seeded = seedForkProviderInstances(explicit, ALL_SEEDS);
    assert.deepEqual(
      seeded[ProviderInstanceId.make("codex-lhc")],
      explicit[ProviderInstanceId.make("codex-lhc")],
    );
    assert.deepEqual(
      seeded[ProviderInstanceId.make("claude-lhc")],
      explicit[ProviderInstanceId.make("claude-lhc")],
    );
    assert.equal(seeded[ProviderInstanceId.make("grok-lhc")]?.displayName, "Grok LHC");
  });

  it("rides the legacy mirror in deriveProviderInstanceConfigMap and is off by default", () => {
    const stock = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    assert.deepEqual(
      Object.keys(stock).filter((id) => id.endsWith("-lhc")),
      [],
    );
    const seeded = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS, ALL_SEEDS);
    assert.deepEqual(
      Object.keys(seeded)
        .filter((id) => id.endsWith("-lhc"))
        .toSorted(),
      ["claude-lhc", "codex-lhc", "grok-lhc"],
    );
    // the mirror rows are untouched
    assert.deepEqual(
      seeded[ProviderInstanceId.make("codex")],
      stock[ProviderInstanceId.make("codex")],
    );
    assert.deepEqual(
      seeded[ProviderInstanceId.make("claudeAgent")],
      stock[ProviderInstanceId.make("claudeAgent")],
    );
  });

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
