#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// Build the LHC fork server archive: server dist (web client bundled at
// dist/client by the server build) + the runtime dependency closure staged the
// way the desktop sidecar stages its Linux half + manifest.json, packed as
// t3code-lhc-<version>-linux-<arch>.tar.gz with a sha256 sidecar. Fork-owned.
//
//   node scripts/build-lhc-archive.ts [--skip-build] [--keep-stage] [--arch x64|arm64] [--out dist-lhc]
//
// The post-pack check extracts the archive to a temp dir and requires
// `node apps/server/dist/bin.mjs --lhc-version` to print the identity line, so
// an archive that lost the JSON import in packing never leaves this script.
// Two builds of one commit are byte-identical: no build time in the manifest,
// tar mtimes pinned to the commit time, gzip -n (see lib/lhc-archive.ts).

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import sidecarPin from "../lhc-release/sidecar.json" with { type: "json" };
import lhcVersion from "../lhc-release/version.json" with { type: "json" };
import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  STAGE_INSTALL_ARGS,
  WSL_RUNTIME_ARCHIVE_EXCLUDED_PREFIXES,
} from "./build-desktop-artifact.ts";
import {
  type ArchiveArch,
  archiveExcludedPrefixes,
  archiveFileName,
  buildManifest,
  expectedLhcVersionLine,
  sha256Line,
  stageDependencies,
  tarArguments,
} from "./lib/lhc-archive.ts";
import {
  assertSidecarPin,
  claudeAgentSdkVersionFromPackage,
  isBundledClaudeExecutablePackage,
  LHC_SIDECAR_ARCHIVE_ROOT,
  LHC_SIDECAR_LAUNCHER,
  packageJsonWithWorkspaceRewrites,
  SIDECAR_NPMRC,
  type NpmPackageJson,
  type SidecarPin,
  type SidecarProvenance,
} from "./lib/lhc-sidecar-stage.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const WorkspaceYaml = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceYaml = Schema.decodeUnknownSync(fromYaml(WorkspaceYaml));
const encodeYaml = Schema.encodeSync(fromYaml(Schema.Unknown));

function parseArgs(argv: ReadonlyArray<string>) {
  const options = {
    skipBuild: false,
    keepStage: false,
    arch: undefined as ArchiveArch | undefined,
    out: "dist-lhc",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--keep-stage") options.keepStage = true;
    else if (arg === "--arch") {
      const value = argv[++i];
      if (value !== "x64" && value !== "arm64")
        throw new Error(`--arch must be x64 or arm64, got ${value}`);
      options.arch = value;
    } else if (arg === "--out") options.out = argv[++i] ?? options.out;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: "true", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout.slice(-4000)}`,
    );
  }
  return result.stdout;
}

function copyTree(source: string, destination: string, skip: ReadonlySet<string>): void {
  NodeFS.mkdirSync(destination, { recursive: true });
  for (const entry of NodeFS.readdirSync(source, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, skip);
    else if (entry.isSymbolicLink()) {
      NodeFS.symlinkSync(NodeFS.readlinkSync(from), to);
    } else NodeFS.copyFileSync(from, to);
  }
}

function readPackageJson(path: string): NpmPackageJson {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as NpmPackageJson;
}

function writePackageJson(path: string, pkg: NpmPackageJson): void {
  NodeFS.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function removeBundledClaudeExecutables(nodeModulesDir: string): void {
  const anthropic = NodePath.join(nodeModulesDir, "@anthropic-ai");
  if (!NodeFS.existsSync(anthropic)) return;
  for (const entry of NodeFS.readdirSync(anthropic, { withFileTypes: true })) {
    if (!isBundledClaudeExecutablePackage(entry.name)) continue;
    NodeFS.rmSync(NodePath.join(anthropic, entry.name), { recursive: true, force: true });
  }
}

/** Materialize the recorded LHC pin as that commit's tree, never a working copy. */
function materializeLhcPin(pin: SidecarPin, dest: string): string {
  NodeFS.mkdirSync(dest, { recursive: true });
  run("git", ["init", "--quiet"], dest);
  run("git", ["remote", "add", "origin", pin.repository], dest);
  run("git", ["fetch", "--quiet", "--depth=1", "origin", pin.commit], dest);
  run("git", ["checkout", "--quiet", "FETCH_HEAD"], dest);
  const commit = run("git", ["rev-parse", "HEAD"], dest).trim();
  assertSidecarPin(commit, pin);
  return dest;
}

function buildLhcDist(source: string, lhcPkg: NpmPackageJson, destDist: string): void {
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-lhc-sdk-build-"));
  try {
    copyTree(
      NodePath.join(source, "packages/lhc"),
      work,
      new Set(["node_modules", "dist", "test"]),
    );
    writePackageJson(NodePath.join(work, "package.json"), lhcPkg);
    console.log("[lhc-archive] installing LHC package build dependencies...");
    run("npm", ["install", "--no-fund", "--no-audit"], work);
    const tsc = NodePath.join(work, "node_modules", "typescript", "bin", "tsc");
    if (!NodeFS.existsSync(tsc)) {
      throw new Error("LHC package install did not provide typescript/bin/tsc");
    }
    run(tsc, ["-p", "tsconfig.json"], work);
    const built = NodePath.join(work, "dist");
    if (!NodeFS.existsSync(NodePath.join(built, "index.js"))) {
      throw new Error("LHC tsc produced no dist/index.js");
    }
    NodeFS.mkdirSync(destDist, { recursive: true });
    copyTree(built, destDist, new Set());
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}

function stageClaudeLhc(stage: string, pin: SidecarPin): SidecarProvenance {
  const sidecarRoot = NodePath.join(stage, LHC_SIDECAR_ARCHIVE_ROOT);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-lhc-sidecar-src-"));
  try {
    const source = materializeLhcPin(pin, NodePath.join(scratch, "repo"));
    const lhcPkg = readPackageJson(NodePath.join(source, "packages/lhc/package.json"));
    const claudePkg = readPackageJson(NodePath.join(source, "packages/claude-lhc/package.json"));
    const claudeAgentSdk = claudeAgentSdkVersionFromPackage(claudePkg);

    const lhcOut = NodePath.join(sidecarRoot, "lhc");
    buildLhcDist(source, lhcPkg, NodePath.join(lhcOut, "dist"));
    writePackageJson(NodePath.join(lhcOut, "package.json"), lhcPkg);

    copyTree(
      NodePath.join(source, "packages/claude-lhc"),
      sidecarRoot,
      new Set(["node_modules", "test", "scripts", "package.json"]),
    );
    writePackageJson(
      NodePath.join(sidecarRoot, "package.json"),
      packageJsonWithWorkspaceRewrites(claudePkg, { lhc: "file:./lhc" }),
    );
    NodeFS.writeFileSync(NodePath.join(sidecarRoot, ".npmrc"), SIDECAR_NPMRC);
    const launcher = NodePath.join(sidecarRoot, "bin", "claude-lhc");
    if (!NodeFS.existsSync(launcher)) throw new Error("claude-lhc launcher missing from LHC pin");
    NodeFS.chmodSync(launcher, 0o755);

    console.log("[lhc-archive] installing claude-lhc JS dependency closure...");
    run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], sidecarRoot);
    removeBundledClaudeExecutables(NodePath.join(sidecarRoot, "node_modules"));
    return { repository: pin.repository, commit: pin.commit, claudeAgentSdk };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [hostPlatform, hostArch] = Effect.runSync(
    Effect.all([HostProcessPlatform, HostProcessArchitecture]),
  );
  if (hostPlatform !== "linux") throw new Error("the LHC archive is built on linux only");
  const arch: ArchiveArch = options.arch ?? (hostArch === "arm64" ? "arm64" : "x64");
  const identity = { version: lhcVersion.version, upstreamTag: lhcVersion.upstreamTag };
  const vp = NodePath.join(repoRoot, "node_modules/.bin/vp");

  if (!options.skipBuild) {
    console.log("[lhc-archive] building server (with web client)...");
    run(vp, ["run", "--filter", "t3", "build"], repoRoot);
  }
  const serverDist = NodePath.join(repoRoot, "apps/server/dist");
  for (const required of ["bin.mjs", "client/index.html"]) {
    if (!NodeFS.existsSync(NodePath.join(serverDist, required))) {
      throw new Error(`apps/server/dist/${required} missing; run without --skip-build`);
    }
  }

  const workspace = decodeWorkspaceYaml(
    NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  // Workspace overrides carry catalog: specs; resolve them the way the desktop
  // sidecar staging does before they reach the stage's pnpm-workspace.yaml.
  const overrides = resolveCatalogDependencies(
    { ...workspace.overrides },
    { ...workspace.catalog },
    "apps/server",
  );
  const dependencies = stageDependencies({
    serverDependencies: serverPackageJson.dependencies,
    catalog: workspace.catalog ?? {},
    arch,
    linuxFffNativeDependencies: (a, version) => resolveFffNativeDependencies("linux", a, version),
  });
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );

  const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-lhc-stage-"));
  try {
    console.log(`[lhc-archive] staging in ${stage}`);
    NodeFS.cpSync(serverDist, NodePath.join(stage, "apps/server/dist"), {
      recursive: true,
      filter: (source) => !source.endsWith(".map"),
    });
    NodeFS.writeFileSync(
      NodePath.join(stage, "package.json"),
      `${JSON.stringify({ name: "t3code-lhc-server", version: identity.version, private: true, packageManager: rootPackageJson.packageManager, dependencies }, null, 2)}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(stage, "pnpm-workspace.yaml"),
      encodeYaml(
        createStageWorkspaceConfig({
          platform: "linux",
          arch,
          allowBuilds: { ...workspace.allowBuilds },
          patchedDependencies,
          overrides,
          linuxServerBackend: true,
        }),
      ),
    );
    if (Object.keys(patchedDependencies).length > 0) {
      NodeFS.cpSync(NodePath.join(repoRoot, "patches"), NodePath.join(stage, "patches"), {
        recursive: true,
      });
    }
    console.log("[lhc-archive] installing runtime dependency closure...");
    run(vp, [...STAGE_INSTALL_ARGS], stage);

    const pin: SidecarPin = sidecarPin;
    console.log(`[lhc-archive] staging ${LHC_SIDECAR_ARCHIVE_ROOT} from ${pin.commit}`);
    const sidecar = stageClaudeLhc(stage, pin);

    const commit = run("git", ["rev-parse", "HEAD"], repoRoot).trim();
    const commitTime = Number(run("git", ["log", "-1", "--format=%ct", "HEAD"], repoRoot).trim());
    const manifest = buildManifest({
      identity,
      commit,
      platform: "linux",
      arch,
      nodeEngine: rootPackageJson.engines.node,
      sidecar,
    });
    NodeFS.writeFileSync(
      NodePath.join(stage, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const outDir = NodePath.resolve(repoRoot, options.out);
    NodeFS.mkdirSync(outDir, { recursive: true });
    const name = archiveFileName({ version: identity.version, platform: "linux", arch });
    const archivePath = NodePath.join(outDir, name);
    NodeFS.rmSync(archivePath, { force: true });
    console.log(`[lhc-archive] packing ${name}`);
    run(
      "tar",
      tarArguments({
        archivePath,
        excludedPrefixes: archiveExcludedPrefixes(WSL_RUNTIME_ARCHIVE_EXCLUDED_PREFIXES),
        mtimeEpochSeconds: commitTime,
      }),
      stage,
    );
    const digest = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(archivePath))
      .digest("hex");
    NodeFS.writeFileSync(`${archivePath}.sha256`, sha256Line(digest, name));

    // Post-pack check: the extracted tree must answer with its identity.
    const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-lhc-probe-"));
    try {
      run("tar", ["-xzf", archivePath], probe);
      const expected = expectedLhcVersionLine(identity);
      const printed = run("node", ["apps/server/dist/bin.mjs", "--lhc-version"], probe, {
        NODE_OPTIONS: "",
      }).trim();
      if (printed !== expected)
        throw new Error(`post-pack identity check failed: got "${printed}", want "${expected}"`);
      if (!NodeFS.existsSync(NodePath.join(probe, "apps/server/dist/client/index.html"))) {
        throw new Error("post-pack check failed: web client missing from the archive");
      }
      const sidecarLauncher = NodePath.join(probe, LHC_SIDECAR_LAUNCHER);
      if (!NodeFS.existsSync(sidecarLauncher)) {
        throw new Error(`post-pack check failed: ${LHC_SIDECAR_LAUNCHER} missing`);
      }
      const packedSdk = sidecar.claudeAgentSdk;
      const sidecarPkg = readPackageJson(
        NodePath.join(probe, LHC_SIDECAR_ARCHIVE_ROOT, "package.json"),
      );
      if (sidecarPkg.dependencies?.["@anthropic-ai/claude-agent-sdk"] !== packedSdk) {
        throw new Error("post-pack check failed: sidecar Agent SDK pin mismatch");
      }
      if (sidecarPkg.dependencies?.lhc !== "file:./lhc") {
        throw new Error("post-pack check failed: sidecar lhc is not file:./lhc");
      }
      const optionalNative = NodePath.join(
        probe,
        LHC_SIDECAR_ARCHIVE_ROOT,
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk-linux-x64",
      );
      if (NodeFS.existsSync(optionalNative)) {
        throw new Error("post-pack check failed: optional SDK Claude binary was packed");
      }
    } finally {
      NodeFS.rmSync(probe, { recursive: true, force: true });
    }
    const size = NodeFS.statSync(archivePath).size;
    console.log(
      JSON.stringify({ archive: archivePath, sha256: digest, bytes: size, manifest }, null, 2),
    );
  } finally {
    if (options.keepStage) console.log(`[lhc-archive] stage kept at ${stage}`);
    else NodeFS.rmSync(stage, { recursive: true, force: true });
  }
}

main();
