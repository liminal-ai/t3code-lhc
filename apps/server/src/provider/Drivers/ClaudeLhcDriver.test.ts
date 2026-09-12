import { describe, expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { ClaudeLhcDriver, claudeLhcContinuationGroupKey } from "./ClaudeLhcDriver.ts";

describe("ClaudeLhcDriver", () => {
  it("is its own driver kind next to the stock Claude driver", () => {
    expect(ClaudeLhcDriver.driverKind).toBe("claude-lhc");
    expect(ClaudeDriver.driverKind).toBe("claudeAgent");
    expect(ClaudeLhcDriver.metadata.displayName).toBe("Claude LHC");
    expect(ClaudeLhcDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(ClaudeLhcDriver.configSchema).toBe(ClaudeDriver.configSchema);
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("claude-lhc");
    expect(new Set(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).size).toBe(
      BUILT_IN_DRIVERS.length,
    );
  });

  it("never shares a continuation group with a stock instance on the same home", () => {
    expect(claudeLhcContinuationGroupKey("claude:home:/home/lee/.claude")).toBe(
      "claude-lhc:home:/home/lee/.claude",
    );
    expect(claudeLhcContinuationGroupKey("other")).toBe("claude-lhc:other");
  });

  it("has no lhc flag in its default config", () => {
    expect("lhc" in ClaudeLhcDriver.defaultConfig()).toBe(false);
  });
});
