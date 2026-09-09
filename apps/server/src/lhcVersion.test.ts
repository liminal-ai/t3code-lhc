import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import * as TestConsole from "effect/testing/TestConsole";

import * as NetService from "@t3tools/shared/Net";
import lhcVersion from "../../../lhc-release/version.json" with { type: "json" };
import { cli } from "./bin.ts";
import { formatLhcVersion, LHC_UPSTREAM_TAG, LHC_VERSION } from "./lhcVersion.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

describe("t3 --lhc-version", () => {
  it("reads lhc-release/version.json, the one source of truth", () => {
    expect(LHC_VERSION).toBe(lhcVersion.version);
    expect(LHC_UPSTREAM_TAG).toBe(lhcVersion.upstreamTag);
    expect(LHC_VERSION).toMatch(/^\d+\.\d+\.\d+(-nightly\.\d+\.\d+)?(-lhc\.[1-9]\d*)?$/);
    expect(`v${LHC_VERSION.replace(/-lhc\.[1-9]\d*$/, "")}`).toBe(LHC_UPSTREAM_TAG);
  });

  // The root command's default handler starts the server; this test finishing
  // is the proof that the flag returns before that.
  it.effect("prints one identity line and exits without starting the server", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.0" })(["--lhc-version"]);
      const lines = yield* TestConsole.logLines;
      expect(lines).toEqual([formatLhcVersion()]);
      expect(lines[0]).toBe(`t3code-lhc ${LHC_VERSION} (upstream ${LHC_UPSTREAM_TAG})`);
    }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, TestConsole.layer))),
  );
});
