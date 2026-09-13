/**
 * forkInstanceSeed — the fork's default LHC provider instances (fork-only).
 *
 * The stock legacy mirror in `ProviderInstanceRegistryHydration` synthesizes
 * one instance per built-in driver from `settings.providers.<kind>`. The
 * fork adds three rows by writing them once into settings.json, each the
 * first time its fork binary is detected while its id is absent:
 *
 *   claude-lhc  driver claude-lhc  when CLAUDE_LHC_SIDECAR names an existing file
 *   codex-lhc   driver codex       when `codex-lhc` resolves on PATH
 *   grok-lhc    driver grok        when `grok-lhc` resolves on PATH
 *
 * The write goes through `ServerSettingsService.updateSettings`, the same
 * command a Settings save uses (validation, normalize, atomic write, change
 * emission). An existing row with the same id is never touched, whatever it
 * says: a seeded row behaves like a driver default, so disable it rather
 * than delete it; a deleted row comes back on the next settings change while
 * the binary is present. Nothing is written while the binary is absent. The
 * web client only lists non-default instances that exist in
 * `settings.providerInstances`, which is why the rows must be persisted
 * rather than merged in memory (lhc.5 defect).
 *
 * Availability is probed when settings load and on every settings change.
 *
 * @module provider/forkInstanceSeed
 */
import {
  CLAUDE_LHC_DRIVER_KIND,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache, isCommandAvailable } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { ServerSettingsService } from "../serverSettings.ts";

export const FORK_INSTANCE_SEED_IDS = ["claude-lhc", "codex-lhc", "grok-lhc"] as const;
export type ForkInstanceSeedId = (typeof FORK_INSTANCE_SEED_IDS)[number];

/** Which fork seeds may appear; the probe fills it in, the merge reads it. */
export type ForkInstanceSeedAvailability = Readonly<Record<ForkInstanceSeedId, boolean>>;

export const NO_FORK_INSTANCE_SEEDS: ForkInstanceSeedAvailability = {
  "claude-lhc": false,
  "codex-lhc": false,
  "grok-lhc": false,
};

const LHC_ACCENT_COLOR = "#7c3aed";

export const FORK_INSTANCE_SEEDS: Readonly<Record<ForkInstanceSeedId, ProviderInstanceConfig>> = {
  "claude-lhc": {
    driver: CLAUDE_LHC_DRIVER_KIND,
    displayName: "Claude LHC",
    accentColor: LHC_ACCENT_COLOR,
    enabled: true,
    config: {},
  },
  "codex-lhc": {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex LHC",
    accentColor: LHC_ACCENT_COLOR,
    enabled: true,
    config: { binaryPath: "codex-lhc", updateSource: "lhc" },
  },
  "grok-lhc": {
    driver: ProviderDriverKind.make("grok"),
    displayName: "Grok LHC",
    accentColor: LHC_ACCENT_COLOR,
    enabled: true,
    config: { binaryPath: "grok-lhc" },
  },
};

/**
 * Seed ids that are available and absent from `providerInstances`, in seed
 * order. Pure. Presence is by id only: an existing row is never compared to
 * the seed, so explicit rows always win.
 */
export const missingForkInstanceSeeds = (
  providerInstances: ServerSettings["providerInstances"],
  availability: ForkInstanceSeedAvailability,
): ReadonlyArray<ForkInstanceSeedId> =>
  FORK_INSTANCE_SEED_IDS.filter(
    (seedId) => availability[seedId] && !Object.hasOwn(providerInstances, seedId),
  );

/**
 * Write the missing seeds into settings.json through the settings-update
 * command, once. Returns the settings after the write, or the input settings
 * unchanged when there was nothing to write. The patch carries the full
 * current `providerInstances` map plus the new rows (the patch schema has no
 * rows-only form), built from the settings passed in at the moment of the
 * write, as a Settings save does.
 */
export const persistForkInstanceSeeds = Effect.fn("persistForkInstanceSeeds")(function* (
  settings: ServerSettings,
  availability: ForkInstanceSeedAvailability,
) {
  const missing = missingForkInstanceSeeds(settings.providerInstances, availability);
  if (missing.length === 0) return settings;
  const providerInstances = { ...settings.providerInstances };
  for (const seedId of missing) {
    providerInstances[ProviderInstanceId.make(seedId)] = FORK_INSTANCE_SEEDS[seedId];
  }
  const serverSettings = yield* ServerSettingsService;
  const next = yield* serverSettings.updateSettings({ providerInstances });
  for (const seedId of missing) {
    yield* Effect.logInfo("provider.instance.seed.persisted", {
      instanceId: seedId,
      driver: FORK_INSTANCE_SEEDS[seedId].driver,
    });
  }
  return next;
});

/**
 * Probe the fork binaries. PATH and CLAUDE_LHC_SIDECAR come from
 * `HostProcessEnvironment`, so tests can point both at a scratch directory.
 */
export const resolveForkInstanceSeedAvailability = Effect.fn("resolveForkInstanceSeedAvailability")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* HostProcessEnvironment;
    const sidecarPath = environment.CLAUDE_LHC_SIDECAR?.trim() ?? "";
    const sidecarPresent =
      sidecarPath === ""
        ? false
        : yield* fileSystem.exists(sidecarPath).pipe(Effect.orElseSucceed(() => false));
    // Fresh lookups every time: the shared resolution cache remembers
    // "not found" for a while, which would hide a binary installed since.
    const available = (command: string) =>
      isCommandAvailable(command).pipe(Effect.provideService(CommandResolutionCache, new Map()));
    return {
      "claude-lhc": sidecarPresent,
      "codex-lhc": yield* available("codex-lhc"),
      "grok-lhc": yield* available("grok-lhc"),
    } satisfies ForkInstanceSeedAvailability;
  },
);
