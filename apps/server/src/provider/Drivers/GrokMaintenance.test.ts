// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "../providerMaintenanceRunner.ts";
import {
  createProviderVersionAdvisory,
  ProviderVersionCache,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceResolutionContext,
} from "../providerMaintenance.ts";
import { makeProviderRegistryMock } from "../testUtils/providerRegistryMock.ts";
import { grokMaintenanceResolver } from "./GrokDriver.ts";

const GROK_DRIVER = ProviderDriverKind.make("grok");

// Two instances of the one Grok driver: a stock install and an LHC build. Both
// update through their own binary; the configured path is the only routing.
function located(commandPath: string): ProviderMaintenanceResolutionContext {
  return {
    binaryPath: commandPath,
    resolvedCommandPath: commandPath,
    realCommandPath: commandPath,
    env: { PATH: "" },
    platform: "linux",
  };
}

it.effect("updates each instance through its own configured binary under one Grok lock", () =>
  Effect.gen(function* () {
    const stock = yield* grokMaintenanceResolver.resolve(located("/usr/local/bin/grok"));
    const lhc = yield* grokMaintenanceResolver.resolve(located("/home/lee/.local/bin/grok-lhc"));
    expect(stock).toEqual({
      provider: "grok",
      packageName: null,
      update: {
        command: "/usr/local/bin/grok update",
        executable: "/usr/local/bin/grok",
        args: ["update"],
        lockKey: "grok",
      },
    });
    expect(lhc).toEqual({
      provider: "grok",
      packageName: null,
      update: {
        command: "/home/lee/.local/bin/grok-lhc update",
        executable: "/home/lee/.local/bin/grok-lhc",
        args: ["update"],
        lockKey: "grok",
      },
    });
    // The version status stays unknown while Update stays available.
    expect(
      createProviderVersionAdvisory({
        driver: lhc.provider,
        currentVersion: "1.0.16",
        latestVersion: null,
        maintenanceCapabilities: lhc,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.16",
      latestVersion: null,
      canUpdate: true,
      updateCommand: "/home/lee/.local/bin/grok-lhc update",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("offers no update when the configured binary cannot be found", () =>
  Effect.gen(function* () {
    const missing = yield* grokMaintenanceResolver.resolve(null);
    expect(missing).toEqual({ provider: "grok", packageName: null, update: null });
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Real execution through the maintenance runner with disposable command
// fixtures standing in for the two binaries. Each fixture records how it was
// invoked; the LHC one fails the way a broken updater would.
const STOCK_INSTANCE_ID = ProviderInstanceId.make("grok_stock");
const LHC_INSTANCE_ID = ProviderInstanceId.make("grok_lhc");

function writeFixture(dir: string, name: string, body: string): string {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, `#!/bin/sh\n${body}\n`);
  NodeFS.chmodSync(path, 0o755);
  return path;
}

const baseProvider = (instanceId: ProviderInstanceId): ServerProvider => ({
  instanceId,
  driver: GROK_DRIVER,
  enabled: true,
  installed: true,
  version: "1.0.16",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-08T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

// The runner also needs an HTTP client for package-version lookups; Grok has
// no package, so any request here is a test failure.
const NoHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))),
  ),
);

const makeRunner = (registry: ProviderRegistryShape) =>
  Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
    Effect.provide(
      ProviderMaintenanceRunner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderRegistry, registry),
            Layer.succeed(ProviderVersionCache, new Map()),
          ),
        ),
      ),
    ),
  );

it.effect("runs the selected instance's binary with `update` and preserves failure status", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-grok-update-"));
    const marker = NodePath.join(tempDir, "invocations");
    const stockBinary = writeFixture(
      tempDir,
      "grok",
      `printf 'stock %s\\n' "$*" >> '${marker}'\necho "grok 1.0.16 is up to date"`,
    );
    const lhcBinary = writeFixture(
      tempDir,
      "grok-lhc",
      `printf 'lhc %s\\n' "$*" >> '${marker}'\necho "no release matched" >&2\nexit 1`,
    );

    // The driver's resolution step, exactly as GrokDriver runs it per instance.
    const env = { PATH: tempDir };
    const capabilities = new Map<ProviderInstanceId, ProviderMaintenanceCapabilities>([
      [
        STOCK_INSTANCE_ID,
        yield* resolveProviderMaintenanceCapabilitiesEffect(grokMaintenanceResolver, {
          binaryPath: stockBinary,
          env,
        }),
      ],
      [
        LHC_INSTANCE_ID,
        yield* resolveProviderMaintenanceCapabilitiesEffect(grokMaintenanceResolver, {
          binaryPath: lhcBinary,
          env,
        }),
      ],
    ]);

    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>([
      baseProvider(STOCK_INSTANCE_ID),
      baseProvider(LHC_INSTANCE_ID),
    ]);
    const mock = makeProviderRegistryMock();
    const registry: ProviderRegistryShape = {
      ...mock,
      getProviders: Ref.get(providersRef),
      refreshInstance: () => Ref.get(providersRef),
      getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) => {
        const resolved = capabilities.get(instanceId);
        return resolved
          ? Effect.succeed(resolved)
          : mock.getProviderMaintenanceCapabilitiesForInstance(instanceId, provider);
      },
      setProviderMaintenanceActionState: (input: {
        readonly instanceId: ProviderInstanceId;
        readonly state: ServerProviderUpdateState | null;
      }) =>
        Ref.updateAndGet(providersRef, (providers) =>
          providers.map((candidate) => {
            if (candidate.instanceId !== input.instanceId) return candidate;
            if (!input.state) {
              const { updateState: _dropped, ...rest } = candidate;
              return rest;
            }
            return { ...candidate, updateState: input.state };
          }),
        ),
    };
    const runner = yield* makeRunner(registry);

    const stockResult = yield* runner.updateProvider({
      provider: GROK_DRIVER,
      instanceId: STOCK_INSTANCE_ID,
    });
    const stockState = stockResult.providers.find(
      (provider) => provider.instanceId === STOCK_INSTANCE_ID,
    )?.updateState;
    assert.strictEqual(stockState?.status, "succeeded");
    assert.strictEqual(
      stockResult.providers.find((provider) => provider.instanceId === LHC_INSTANCE_ID)
        ?.updateState,
      undefined,
    );

    const lhcResult = yield* runner.updateProvider({
      provider: GROK_DRIVER,
      instanceId: LHC_INSTANCE_ID,
    });
    const lhcState = lhcResult.providers.find(
      (provider) => provider.instanceId === LHC_INSTANCE_ID,
    )?.updateState;
    assert.strictEqual(lhcState?.status, "failed");
    assert.strictEqual(lhcState?.message, "Update command exited with code 1.");
    assert.include(lhcState?.output ?? "", "no release matched");

    // Each instance ran its own binary, once, with the native `update` argument.
    assert.deepStrictEqual(NodeFS.readFileSync(marker, "utf8").trimEnd().split("\n"), [
      "stock update",
      "lhc update",
    ]);
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NoHttpClient, Layer.succeed(HostProcessPlatform, "linux")),
    ),
  ),
);
