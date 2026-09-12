/**
 * ClaudeLhcDriver — the `claude-lhc` driver kind (fork-only).
 *
 * Same runtime, probe, capabilities cache and text generation as
 * `ClaudeDriver`, built through `makeClaudeDriver`; the difference is that
 * every generation runs the SDK inside the claude-lhc sidecar (which records
 * the thread into LHC and rebuilds context on compaction) and that its
 * continuation key never groups with a stock Claude instance on the same home.
 *
 * @module provider/Drivers/ClaudeLhcDriver
 */
import { CLAUDE_LHC_DRIVER_KIND } from "@t3tools/contracts";

import { makeClaudeDriver } from "./ClaudeDriver.ts";
import { makeClaudeLhcCreateQuery } from "./ClaudeLhcSidecar.ts";

const STOCK_CONTINUATION_PREFIX = "claude:";

export const claudeLhcContinuationGroupKey = (stockKey: string): string =>
  stockKey.startsWith(STOCK_CONTINUATION_PREFIX)
    ? `claude-lhc:${stockKey.slice(STOCK_CONTINUATION_PREFIX.length)}`
    : `claude-lhc:${stockKey}`;

export const ClaudeLhcDriver = makeClaudeDriver({
  driverKind: CLAUDE_LHC_DRIVER_KIND,
  displayName: "Claude LHC",
  createQuery: makeClaudeLhcCreateQuery,
  continuationGroupKey: claudeLhcContinuationGroupKey,
});
