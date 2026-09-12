/**
 * forkInstanceSeed — the fork's default LHC provider instances (fork-only).
 *
 * The stock legacy mirror in `ProviderInstanceRegistryHydration` synthesizes
 * one instance per built-in driver from `settings.providers.<kind>`. The
 * fork adds three more rows the same way, ephemeral and never written to
 * settings.json, each present only while its fork binary resolves:
 *
 *   claude-lhc  driver claude-lhc  when CLAUDE_LHC_SIDECAR names an existing file
 *   codex-lhc   driver codex       when `codex-lhc` resolves on PATH
 *   grok-lhc    driver grok        when `grok-lhc` resolves on PATH
 *
 * An explicit `providerInstances` entry with the same id always wins, as it
 * does for the mirror. Editing a seeded row in Settings writes it explicit.
 * Availability is probed when settings load and on every settings change,
 * which is exactly when the mirror is re-derived; the Providers refresh
 * button only re-probes snapshots, so a binary installed later shows up on
 * the next settings save or restart.
 *
 * @module provider/forkInstanceSeed
 */
import {
  CLAUDE_LHC_DRIVER_KIND,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CommandResolutionCache, isCommandAvailable } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";

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

/** Add every available seed whose id is not already in the map. Pure. */
export const seedForkProviderInstances = (
  map: ProviderInstanceConfigMap,
  availability: ForkInstanceSeedAvailability,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...map };
  for (const seedId of FORK_INSTANCE_SEED_IDS) {
    if (!availability[seedId]) continue;
    const instanceId = ProviderInstanceId.make(seedId);
    if (instanceId in merged) continue;
    merged[instanceId] = FORK_INSTANCE_SEEDS[seedId];
  }
  return merged as ProviderInstanceConfigMap;
};

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

/**
 * Last probe result, shared by the registry hydration (writer) and any
 * other reader of the derived config map (the terminal manager). Defaults
 * to nothing seeded so code paths that never probe see the stock mirror.
 */
export const ForkInstanceSeedAvailabilityState = Context.Reference<
  Ref.Ref<ForkInstanceSeedAvailability>
>("t3code-lhc/ForkInstanceSeedAvailabilityState", {
  defaultValue: () => Ref.makeUnsafe(NO_FORK_INSTANCE_SEEDS),
});
