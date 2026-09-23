// @effect-diagnostics nodeBuiltinImport:off
// Pure helpers for bundling claude-lhc into the T3 LHC archive. The sidecar is
// the published claude-lhc npm package (lhc core bundled inside it), installed
// at the version lhc-release/sidecar.json records. IO lives in
// scripts/build-lhc-archive.ts.

import * as NodePath from "node:path";

export const LHC_SIDECAR_ARCHIVE_ROOT = "vendor/claude-lhc";
export const LHC_SIDECAR_LAUNCHER = `${LHC_SIDECAR_ARCHIVE_ROOT}/dist/sidecar.js`;

/** lhc-release/sidecar.json: the published claude-lhc package the archive installs. */
export interface SidecarPin {
  readonly package: string;
  readonly version: string;
}

export interface SidecarProvenance extends SidecarPin {
  readonly claudeAgentSdk: string;
  /** `npm`, or `tarball:<sha256>` for a local pre-publish build of the same version. */
  readonly source: string;
}

/** Bundled Claude executables (~200MB). T3 passes pathToClaudeCodeExecutable. */
export const SIDECAR_OPTIONAL_SDK_EXCLUDE_PREFIX = `${LHC_SIDECAR_ARCHIVE_ROOT}/node_modules/@anthropic-ai/claude-agent-sdk-`;

export const BUNDLED_CLAUDE_EXECUTABLE_PACKAGE_PREFIX = "claude-agent-sdk-";

export function isBundledClaudeExecutablePackage(name: string): boolean {
  return name.startsWith(BUNDLED_CLAUDE_EXECUTABLE_PACKAGE_PREFIX);
}

/** True when a packed node_modules/lhc path stays inside the extracted archive. */
export function packedLhcResolvesInsideArchive(
  packedLhcPath: string,
  archiveRoot: string,
): boolean {
  const root = NodePath.resolve(archiveRoot);
  const resolved = NodePath.resolve(packedLhcPath);
  const relative = NodePath.relative(root, resolved);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

export interface NpmPackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export function claudeAgentSdkVersionFromPackage(pkg: NpmPackageJson): string {
  const version = pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (version === undefined || version === "") {
    throw new Error("claude-lhc package.json has no @anthropic-ai/claude-agent-sdk dependency");
  }
  return version;
}

/** The installed package must be exactly the recorded one, whichever source it came from. */
export function assertSidecarPackage(pkg: NpmPackageJson, expected: SidecarPin): void {
  if (pkg.name !== expected.package || pkg.version !== expected.version) {
    throw new Error(
      `installed sidecar is ${pkg.name}@${pkg.version}, not the recorded ${expected.package}@${expected.version}`,
    );
  }
}

/** npm install spec: the registry version, or a local tarball of that version. */
export function sidecarInstallSpec(pin: SidecarPin, tarballPath: string | undefined): string {
  return tarballPath === undefined ? pin.version : `file:${NodePath.resolve(tarballPath)}`;
}
