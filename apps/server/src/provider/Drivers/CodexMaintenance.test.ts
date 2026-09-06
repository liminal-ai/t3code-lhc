import { expect, it } from "@effect/vitest";
import { createProviderVersionAdvisory } from "../providerMaintenance.ts";
import { codexMaintenanceResolver } from "./CodexDriver.ts";

// Two instances of the one Codex driver: a stock install keeps the package
// resolver, an LHC build updates through its own binary.
const stock = codexMaintenanceResolver("stock").resolve({
  binaryPath: "/opt/homebrew/bin/codex",
  env: { PATH: "" },
});
const lhc = codexMaintenanceResolver("lhc").resolve({
  binaryPath: "/home/lee/.local/bin/codex-lhc",
  env: { PATH: "" },
});

it("keeps the stock instance on the package-managed resolver", () => {
  expect(stock).toEqual({
    provider: "codex",
    packageName: "@openai/codex",
    update: {
      command: "brew upgrade codex",
      executable: "brew",
      args: ["upgrade", "codex"],
      lockKey: "homebrew",
    },
  });
});

it("updates an LHC instance through the configured binary with no package to compare against", () => {
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
});

it("falls back to the codex command when an LHC instance has no binary path", () => {
  expect(codexMaintenanceResolver("lhc").resolve({ binaryPath: "" }).update?.executable).toBe(
    "codex",
  );
});

it("lets an LHC instance update while its version status stays unknown", () => {
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
});
