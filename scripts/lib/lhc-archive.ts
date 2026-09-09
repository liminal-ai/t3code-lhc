// Pure helpers for the LHC fork server archive (scripts/build-lhc-archive.ts).
// Kept free of IO so the naming, manifest, dependency-closure and tar-argument
// rules are unit-testable; the runner does the copying and spawning.

import { selectCliRuntimeExternalDependencies } from "./cli-external-packages.ts";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export type ArchivePlatform = "linux";
export type ArchiveArch = "x64" | "arm64";

export const ARCHIVE_ROOTS = ["manifest.json", "apps/server/dist", "node_modules"] as const;

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
  readonly createdAt: string;
  readonly roots: ReadonlyArray<string>;
}

export function buildManifest(input: {
  readonly identity: ArchiveIdentity;
  readonly commit: string;
  readonly platform: ArchivePlatform;
  readonly arch: ArchiveArch;
  readonly nodeEngine: string;
  readonly createdAt: Date;
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
    createdAt: input.createdAt.toISOString(),
    roots: [...ARCHIVE_ROOTS],
  };
}

/**
 * The runtime dependency closure to stage: the server's runtime-external
 * packages (catalog specs resolved) plus the Linux fff native binaries, the
 * same selection the desktop sidecar staging makes for its Linux half.
 */
export function stageDependencies(input: {
  readonly serverDependencies: Readonly<Record<string, string>>;
  readonly catalog: Readonly<Record<string, string>>;
  readonly arch: ArchiveArch;
  readonly linuxFffNativeDependencies: (
    arch: ArchiveArch,
    version: string,
  ) => Record<string, string>;
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
  return { ...runtimeExternals, ...input.linuxFffNativeDependencies(input.arch, fffVersion) };
}

/** Source maps are never shipped; everything else follows the shared WSL list. */
export const ARCHIVE_EXTRA_EXCLUDES = ["*.map"] as const;

/**
 * The shared WSL list drops `node-pty/build` because that archive ships a
 * separately staged prebuild. This archive has no prebuild step: the stage
 * install compiles pty.node into build/Release, so keep that and drop only the
 * compiler intermediates beside it.
 */
export function archiveExcludedPrefixes(shared: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    ...shared.filter((prefix) => prefix !== "node_modules/node-pty/build"),
    "node_modules/node-pty/build/Release/obj",
    "node_modules/node-pty/build/Release/.deps",
    "node_modules/node-pty/build/Makefile",
    "node_modules/node-pty/build/binding.Makefile",
    "node_modules/node-pty/build/config.gypi",
    "node_modules/node-pty/build/deps",
    "node_modules/node-pty/build/node_gyp_bins",
  ];
}

export function tarArguments(input: {
  readonly archivePath: string;
  readonly excludedPrefixes: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    ...ARCHIVE_EXTRA_EXCLUDES.map((glob) => `--exclude=${glob}`),
    ...input.excludedPrefixes.map((prefix) => `--exclude=${prefix}*`),
    "-czf",
    input.archivePath,
    ...ARCHIVE_ROOTS,
  ];
}

/** `sha256sum` line format so `sha256sum -c` verifies it. */
export function sha256Line(hexDigest: string, fileName: string): string {
  return `${hexDigest}  ${fileName}\n`;
}
