// Pure helpers for the LHC fork server archive (scripts/build-lhc-archive.ts).
// Kept free of IO so the naming, manifest, dependency-closure and tar-argument
// rules are unit-testable; the runner does the copying and spawning.

import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import {
  LHC_SIDECAR_ARCHIVE_ROOT,
  SIDECAR_OPTIONAL_SDK_EXCLUDE_PREFIX,
  type SidecarProvenance,
} from "./lhc-sidecar-stage.ts";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export type ArchivePlatform = "linux" | "darwin" | "win32";
export type ArchiveArch = "x64" | "arm64";

export const ARCHIVE_TARGETS = [
  { platform: "linux", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "win32", arch: "x64" },
] as const satisfies ReadonlyArray<{ platform: ArchivePlatform; arch: ArchiveArch }>;

export function isArchiveTarget(
  platform: string,
  arch: string,
): { platform: ArchivePlatform; arch: ArchiveArch } | undefined {
  return ARCHIVE_TARGETS.find((target) => target.platform === platform && target.arch === arch);
}

export const ARCHIVE_ROOTS = [
  "manifest.json",
  "apps/server/dist",
  "node_modules",
  LHC_SIDECAR_ARCHIVE_ROOT,
] as const;

export interface ArchiveIdentity {
  readonly version: string;
  readonly upstreamTag: string;
}

/** Mirrors `formatLhcVersionLine` in apps/server/src/lhcVersion.ts; the post-pack
 *  check compares the real CLI output against this, so drift fails the build. */
export function expectedLhcVersionLine(identity: ArchiveIdentity): string {
  return `t3code-lhc ${identity.version} (upstream ${identity.upstreamTag})`;
}

export function archiveFileName(input: {
  readonly version: string;
  readonly platform: ArchivePlatform;
  readonly arch: ArchiveArch;
}): string {
  return `t3code-lhc-${input.version}-${input.platform}-${input.arch}.tar.gz`;
}

/** Parse `<version>` back out of an archive file name; null if it is not ours. */
export function archiveVersionFromFileName(
  fileName: string,
  platform: ArchivePlatform,
  arch: ArchiveArch,
): string | null {
  const suffix = `-${platform}-${arch}.tar.gz`;
  const prefix = "t3code-lhc-";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null;
  const version = fileName.slice(prefix.length, fileName.length - suffix.length);
  return version.length > 0 ? version : null;
}

export interface ArchiveManifest {
  readonly name: string;
  readonly version: string;
  readonly upstreamTag: string;
  readonly commit: string;
  readonly platform: ArchivePlatform;
  readonly arch: ArchiveArch;
  readonly node: string;
  readonly roots: ReadonlyArray<string>;
  readonly sidecar: SidecarProvenance;
}

export function buildManifest(input: {
  readonly identity: ArchiveIdentity;
  readonly commit: string;
  readonly platform: ArchivePlatform;
  readonly arch: ArchiveArch;
  readonly nodeEngine: string;
  readonly sidecar: SidecarProvenance;
}): ArchiveManifest {
  return {
    name: archiveFileName({
      version: input.identity.version,
      platform: input.platform,
      arch: input.arch,
    }),
    version: input.identity.version,
    upstreamTag: input.identity.upstreamTag,
    commit: input.commit,
    platform: input.platform,
    arch: input.arch,
    node: input.nodeEngine,
    roots: [...ARCHIVE_ROOTS],
    sidecar: {
      repository: input.sidecar.repository,
      commit: input.sidecar.commit,
      claudeAgentSdk: input.sidecar.claudeAgentSdk,
    },
  };
}

/**
 * The runtime dependency closure to stage: the server's runtime-external
 * packages (catalog specs resolved) plus the target platform's fff native
 * binaries, the same selection the desktop sidecar staging makes.
 */
export function stageDependencies(input: {
  readonly serverDependencies: Readonly<Record<string, string>>;
  readonly catalog: Readonly<Record<string, string>>;
  readonly arch: ArchiveArch;
  readonly fffNativeDependencies: (arch: ArchiveArch, version: string) => Record<string, string>;
}): Record<string, string> {
  const resolved = resolveCatalogDependencies(
    { ...input.serverDependencies },
    { ...input.catalog },
    "apps/server",
  );
  const runtimeExternals = selectCliRuntimeExternalDependencies(resolved);
  const fffVersion = resolved["@ff-labs/fff-node"];
  if (fffVersion === undefined) {
    throw new Error("apps/server/package.json has no @ff-labs/fff-node dependency");
  }
  return { ...runtimeExternals, ...input.fffNativeDependencies(input.arch, fffVersion) };
}

/** Source maps are never shipped; everything else follows the shared WSL list. */
export const ARCHIVE_EXTRA_EXCLUDES = ["*.map"] as const;

/**
 * Linux compiles pty.node into build/Release. macOS/Windows keep the published
 * node-pty prebuilds (and Windows conpty). Shared WSL exclusions drop the
 * other platforms' natives.
 */
export function archiveExcludedPrefixes(
  shared: ReadonlyArray<string>,
  platform: ArchivePlatform = "linux",
): ReadonlyArray<string> {
  const keep =
    platform === "linux"
      ? new Set(["node_modules/node-pty/build"])
      : platform === "darwin"
        ? new Set(["node_modules/node-pty/prebuilds/darwin-"])
        : new Set([
            "node_modules/node-pty/prebuilds/win32-",
            "node_modules/node-pty/third_party/conpty",
            "node_modules/@msgpackr-extract/msgpackr-extract-win32-",
            "node_modules/@ff-labs/fff-bin-win32-",
            "node_modules/@yuuang/ffi-rs-win32-",
          ]);
  const prefixes = shared.filter((prefix) => !keep.has(prefix));
  if (platform === "linux") {
    prefixes.push(
      "node_modules/node-pty/build/Release/obj",
      "node_modules/node-pty/build/Release/.deps",
      "node_modules/node-pty/build/Makefile",
      "node_modules/node-pty/build/binding.Makefile",
      "node_modules/node-pty/build/config.gypi",
      "node_modules/node-pty/build/deps",
      "node_modules/node-pty/build/node_gyp_bins",
    );
  }
  prefixes.push(SIDECAR_OPTIONAL_SDK_EXCLUDE_PREFIX);
  return prefixes;
}

/**
 * Two builds of one commit must produce one archive byte for byte: entry
 * order, ownership and mtime are pinned (mtime to the commit's committer time,
 * in whole seconds since the epoch) and gzip runs with -n so its header carries
 * no timestamp. The manifest itself has no build time for the same reason.
 */
export function tarArguments(input: {
  readonly archivePath: string;
  readonly excludedPrefixes: ReadonlyArray<string>;
  readonly mtimeEpochSeconds: number;
  readonly forceLocal?: boolean;
}): ReadonlyArray<string> {
  if (!Number.isInteger(input.mtimeEpochSeconds) || input.mtimeEpochSeconds < 0) {
    throw new Error(
      `mtimeEpochSeconds must be a non-negative integer, got ${input.mtimeEpochSeconds}`,
    );
  }
  return [
    ...(input.forceLocal === true ? ["--force-local"] : []),
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--mtime=@${input.mtimeEpochSeconds}`,
    "--use-compress-program=gzip -n",
    ...ARCHIVE_EXTRA_EXCLUDES.map((glob) => `--exclude=${glob}`),
    ...input.excludedPrefixes.map((prefix) => `--exclude=${prefix}*`),
    "-cf",
    input.archivePath,
    ...ARCHIVE_ROOTS,
  ];
}

/** Extract args. `--force-local` must precede `-xzf` so `-f` is not that flag. */
export function tarExtractArguments(input: {
  readonly archivePath: string;
  readonly forceLocal?: boolean;
}): ReadonlyArray<string> {
  return [...(input.forceLocal === true ? ["--force-local"] : []), "-xzf", input.archivePath];
}

/** True when `tar --version` is GNU tar (required for --sort/--mtime/--owner). */
export function isGnuTarVersion(versionText: string): boolean {
  return /\bGNU tar\b/i.test(versionText);
}

export const LHC_ARCHIVE_NPM_VERSION = "11.16.0";

/** npm 11.4.2 crashed the original LHC pin install. */
export function isQualifiedArchiveNpm(versionText: string): boolean {
  const version = versionText.trim().split(/\s+/)[0] ?? "";
  return version === LHC_ARCHIVE_NPM_VERSION;
}

/** `sha256sum` line format so `sha256sum -c` verifies it. */
export function sha256Line(hexDigest: string, fileName: string): string {
  return `${hexDigest}  ${fileName}\n`;
}
