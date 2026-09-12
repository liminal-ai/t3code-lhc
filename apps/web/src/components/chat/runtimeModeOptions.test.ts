import { describe, expect, it } from "vite-plus/test";

import { RUNTIME_MODE_OPTIONS, offeredRuntimeModeOptions } from "./runtimeModeOptions";

describe("offeredRuntimeModeOptions", () => {
  it("offers all four modes by default", () => {
    expect(offeredRuntimeModeOptions(false)).toEqual(RUNTIME_MODE_OPTIONS);
    expect(offeredRuntimeModeOptions(false)).toContain("full-access");
  });

  it("drops only Full access when hidden", () => {
    expect(offeredRuntimeModeOptions(true)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
    ]);
  });
});
