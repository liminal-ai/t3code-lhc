import { ClaudeLhcSettings, ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";

describe("claude-lhc driver option", () => {
  it("is offered next to Claude with the LHC settings schema and the same icon", () => {
    const claude = getDriverOption(ProviderDriverKind.make("claudeAgent"));
    const lhc = getDriverOption(ProviderDriverKind.make("claude-lhc"));
    expect(lhc?.label).toBe("Claude LHC");
    expect(lhc?.settingsSchema).toBe(ClaudeLhcSettings);
    expect(claude?.settingsSchema).toBe(ClaudeSettings);
    expect(lhc?.settingsSchema).not.toBe(claude?.settingsSchema);
    expect(lhc?.icon).toBe(claude?.icon);
    const kinds = DRIVER_OPTIONS.map((option) => option.value);
    expect(kinds.indexOf("claude-lhc" as never)).toBe(kinds.indexOf("claudeAgent" as never) + 1);
  });
});
