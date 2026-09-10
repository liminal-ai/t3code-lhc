// Pure helpers for bundling claude-lhc into the T3 LHC archive.
// Dependency versions come from the recorded LHC pin's package.json files;
// this module only rewrites workspace: protocol refs. IO lives in
// scripts/build-lhc-archive.ts.

import * as NodePath from "node:path";

export const LHC_SIDECAR_ARCHIVE_ROOT = "vendor/claude-lhc";
export const LHC_SIDECAR_LAUNCHER = `${LHC_SIDECAR_ARCHIVE_ROOT}/dist/sidecar.js`;

export interface SidecarPin {
  readonly repository: string;
  readonly commit: string;
}

export interface SidecarProvenance extends SidecarPin {
  readonly claudeAgentSdk: string;
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

/** Hoisted physical node_modules. Optional deps stay on; executables are removed by name.
 *  install-links copies file: deps instead of a Windows junction to the stage path. */
export const SIDECAR_NPMRC = "node-linker=hoisted\ninstall-links=true\n";

const WORKSPACE_PROTOCOL = "workspace:";

/**
 * Copy a dependency map, replacing `workspace:` specs with the given file: path.
 * Unknown workspace names throw so a new workspace dep cannot ship unresolved.
 */
export function rewriteWorkspaceDependencies(
  dependencies: Readonly<Record<string, string>>,
  fileBindings: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!spec.startsWith(WORKSPACE_PROTOCOL)) {
      out[name] = spec;
      continue;
    }
    const bound = fileBindings[name];
    if (bound === undefined) {
      throw new Error(`workspace dependency ${name} has no file: binding`);
    }
    out[name] = bound;
  }
  return out;
}

export interface NpmPackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

/** Source package.json with workspace: specs rewritten; all other fields kept. */
export function packageJsonWithWorkspaceRewrites(
  pkg: NpmPackageJson,
  fileBindings: Readonly<Record<string, string>>,
): NpmPackageJson {
  return {
    ...pkg,
    ...(pkg.dependencies === undefined
      ? {}
      : { dependencies: rewriteWorkspaceDependencies(pkg.dependencies, fileBindings) }),
    ...(pkg.optionalDependencies === undefined
      ? {}
      : {
          optionalDependencies: rewriteWorkspaceDependencies(
            pkg.optionalDependencies,
            fileBindings,
          ),
        }),
  };
}

export function claudeAgentSdkVersionFromPackage(pkg: NpmPackageJson): string {
  const version = pkg.dependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (version === undefined || version === "") {
    throw new Error("claude-lhc package.json has no @anthropic-ai/claude-agent-sdk dependency");
  }
  return version;
}

export function assertSidecarPin(actual: string, expected: SidecarPin): void {
  if (actual !== expected.commit) {
    throw new Error(
      `LHC sidecar source commit ${actual} is not the recorded pin ${expected.commit}`,
    );
  }
}
