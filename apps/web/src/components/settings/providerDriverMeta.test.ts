import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";

describe("claude-lhc driver option", () => {
  it("is offered next to Claude with the same settings schema and icon", () => {
    const claude = getDriverOption(ProviderDriverKind.make("claudeAgent"));
    const lhc = getDriverOption(ProviderDriverKind.make("claude-lhc"));
    expect(lhc?.label).toBe("Claude LHC");
    expect(lhc?.settingsSchema).toBe(claude?.settingsSchema);
    expect(lhc?.icon).toBe(claude?.icon);
    const kinds = DRIVER_OPTIONS.map((option) => option.value);
    expect(kinds.indexOf("claude-lhc" as never)).toBe(kinds.indexOf("claudeAgent" as never) + 1);
  });
});
