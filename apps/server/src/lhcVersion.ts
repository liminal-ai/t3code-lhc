import * as Console from "effect/Console";
import { Flag } from "effect/unstable/cli";

import lhcVersion from "../../../lhc-release/version.json" with { type: "json" };

/**
 * The fork's identity, read from `lhc-release/version.json`, the one file the
 * CLI flag and the server environment descriptor share. `version` is the
 * upstream version the build incorporates (a nightly keeps its full string),
 * optionally with a `-lhc.N` fork revision suffix; `upstreamTag` is the tag
 * that version was released as. `scripts/check-lhc-touch.sh` keeps both in
 * step with `lhc-release/BASE_TAG`. Fork versions are never ordered by code:
 * "latest" is GitHub's latest-release marker, comparisons are equality only.
 */
export const LHC_VERSION: string = lhcVersion.version;
export const LHC_UPSTREAM_TAG: string = lhcVersion.upstreamTag;

export const formatLhcVersion = (): string =>
  `t3code-lhc ${LHC_VERSION} (upstream ${LHC_UPSTREAM_TAG})`;

export const lhcVersionFlag = Flag.boolean("lhc-version").pipe(
  Flag.withDescription("Print the LHC fork identity (version and upstream tag) and exit."),
);

export const printLhcVersion = Console.log(formatLhcVersion());
