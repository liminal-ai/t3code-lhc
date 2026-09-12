import type { RuntimeMode } from "@t3tools/contracts";

/** Composer order for the access-mode pickers. */
export const RUNTIME_MODE_OPTIONS: readonly RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/**
 * Modes the composer offers. The `hideFullAccess` server setting only removes
 * the choice; a thread already in Full access keeps its label and nothing is
 * rejected.
 */
export function offeredRuntimeModeOptions(hideFullAccess: boolean): readonly RuntimeMode[] {
  return hideFullAccess
    ? RUNTIME_MODE_OPTIONS.filter((mode) => mode !== "full-access")
    : RUNTIME_MODE_OPTIONS;
}
