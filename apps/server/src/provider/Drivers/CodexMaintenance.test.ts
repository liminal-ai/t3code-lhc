import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  createProviderVersionAdvisory,
  type ProviderMaintenanceResolutionContext,
} from "../providerMaintenance.ts";
import { codexMaintenanceResolver } from "./CodexDriver.ts";

const SHARED_HOME = "/home/lee/.codex";

function located(commandPath: string): ProviderMaintenanceResolutionContext {
  return {
    binaryPath: commandPath,
    resolvedCommandPath: commandPath,
    realCommandPath: commandPath,
    env: { PATH: "" },
    platform: "linux",
  };
}

// Two instances of the one Codex driver: a stock install keeps upstream's
// package-managed resolver, an LHC build updates through its own binary.
it.effect("keeps the stock instance on the package-managed resolver", () =>
  Effect.gen(function* () {
    const standalone = yield* codexMaintenanceResolver("stock", SHARED_HOME).resolve(
      located(`${SHARED_HOME}/packages/standalone/bin/codex`),
    );
    expect(standalone.packageName).toBe("@openai/codex");
    expect(standalone.update).toMatchObject({
      args: ["update"],
      lockKey: "codex-native",
      env: { CODEX_HOME: SHARED_HOME },
    });
    const missing = yield* codexMaintenanceResolver("stock", SHARED_HOME).resolve(null);
    expect(missing.update).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "updates an LHC instance through the configured binary with no package to compare against",
  () =>
    Effect.gen(function* () {
      const lhc = yield* codexMaintenanceResolver("lhc", SHARED_HOME).resolve(
        located("/home/lee/.local/bin/codex-lhc"),
      );
      expect(lhc).toEqual({
        provider: "codex",
        packageName: null,
        update: {
          command: "/home/lee/.local/bin/codex-lhc update",
          executable: "/home/lee/.local/bin/codex-lhc",
          args: ["update"],
          lockKey: "codex-lhc",
        },
      });
      expect(
        createProviderVersionAdvisory({
          driver: lhc.provider,
          currentVersion: "0.42.0",
          latestVersion: null,
          maintenanceCapabilities: lhc,
        }),
      ).toMatchObject({
        status: "unknown",
        currentVersion: "0.42.0",
        latestVersion: null,
        canUpdate: true,
        updateCommand: "/home/lee/.local/bin/codex-lhc update",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("offers no update when an LHC instance's binary cannot be found", () =>
  Effect.gen(function* () {
    const missing = yield* codexMaintenanceResolver("lhc", SHARED_HOME).resolve(null);
    expect(missing).toEqual({ provider: "codex", packageName: null, update: null });
  }).pipe(Effect.provide(NodeServices.layer)),
);
