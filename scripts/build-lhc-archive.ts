#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
// Build the LHC fork server archive: server dist (web client bundled at
// dist/client by the server build) + the runtime dependency closure staged the
// way the desktop sidecar stages its Linux half + manifest.json, packed as
// t3code-lhc-<version>-<platform>-<arch>.tar.gz with a sha256 sidecar. Fork-owned.
//
//   node scripts/build-lhc-archive.ts [--skip-build] [--keep-stage]
//     [--platform linux|darwin|win32] [--arch x64|arm64] [--out dist-lhc]
//     [--sidecar-tarball claude-lhc-<version>.tgz]
//
// The Claude LHC sidecar is the claude-lhc npm package at the version
// lhc-release/sidecar.json records; --sidecar-tarball installs a local pack of
// that same version instead (before it is published). Requires GNU tar
// (LHC_ARCHIVE_TAR); npm is the one bundled with this Node (LHC_ARCHIVE_NPM
// overrides with an npm-cli.js).
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
} from "./build-desktop-artifact.ts";
import {
  LHC_ARCHIVE_EXCLUDED_PREFIXES,
  ARCHIVE_SCRIPTS,
  type ArchiveArch,
  type ArchivePlatform,
  archiveExcludedPrefixes,
  archiveFileName,
  buildManifest,
  expectedLhcVersionLine,
  isArchiveTarget,
  isGnuTarVersion,
  sha256Line,
  stageDependencies,
  tarArguments,
  tarExtractArguments,
} from "./lib/lhc-archive.ts";
import {
  assertSidecarPackage,
  claudeAgentSdkVersionFromPackage,
  isBundledClaudeExecutablePackage,
  LHC_SIDECAR_ARCHIVE_ROOT,
  LHC_SIDECAR_LAUNCHER,
  packedLhcResolvesInsideArchive,
  sidecarInstallSpec,
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
    platform: undefined as ArchivePlatform | undefined,
    arch: undefined as ArchiveArch | undefined,
    out: "dist-lhc",
    sidecarTarball: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--keep-stage") options.keepStage = true;
    else if (arg === "--platform") {
      const value = argv[++i];
      if (value !== "linux" && value !== "darwin" && value !== "win32") {
        throw new Error(`--platform must be linux, darwin, or win32, got ${value}`);
      }
      options.platform = value;
    } else if (arg === "--arch") {
      const value = argv[++i];
      if (value !== "x64" && value !== "arm64")
        throw new Error(`--arch must be x64 or arm64, got ${value}`);
      options.arch = value;
    } else if (arg === "--out") options.out = argv[++i] ?? options.out;
    else if (arg === "--sidecar-tarball") {
      const value = argv[++i];
      if (value === undefined || !NodeFS.existsSync(value)) {
        throw new Error(`--sidecar-tarball needs an existing .tgz, got ${value}`);
      }
      options.sidecarTarball = NodePath.resolve(value);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/** The npm bundled with this Node, unless LHC_ARCHIVE_NPM names an npm-cli.js. */
function resolveArchiveNpm(): string {
  const override = process.env.LHC_ARCHIVE_NPM?.trim();
  if (override !== undefined && override !== "") return override;
  const candidates = [
    NodePath.join(NodePath.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    NodePath.join(
      NodePath.dirname(NodePath.dirname(process.execPath)),
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const found = candidates.find((candidate) => NodeFS.existsSync(candidate));
  if (found === undefined) {
    throw new Error(`cannot locate npm (checked ${candidates.join(", ")}); set LHC_ARCHIVE_NPM`);
  }
  return found;
}

function runNpm(args: ReadonlyArray<string>, cwd: string): string {
  return runNodeCli(resolveArchiveNpm(), args, cwd);
}

function runNodeCli(cli: string, args: ReadonlyArray<string>, cwd: string): string {
  if (cli.endsWith(".js") || cli.endsWith(".cjs") || cli.endsWith(".mjs")) {
    return run(process.execPath, [cli, ...args], cwd);
  }
  throw new Error(`LHC_ARCHIVE_NPM must be a Node .js CLI, got ${cli}`);
}

function runVp(args: ReadonlyArray<string>, cwd: string): string {
  const vpJs = NodePath.join(repoRoot, "node_modules", "vite-plus", "bin", "vp");
  if (!NodeFS.existsSync(vpJs)) {
    throw new Error(`vite-plus bin/vp missing at ${vpJs}`);
  }
  return run(process.execPath, [vpJs, ...args], cwd);
}

function gnuTarPath(): string {
  return NodePath.dirname(resolveGnuTar());
}

function withGnuTarPath(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const tarDir = gnuTarPath();
  const current = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const prefixed = `${tarDir}${NodePath.delimiter}${current}`;
  return {
    ...env,
    PATH: prefixed,
    Path: prefixed,
  };
}

function resolveGnuTar(): string {
  const override = process.env.LHC_ARCHIVE_TAR?.trim();
  const candidates = [
    ...(override ? [override] : []),
    "gtar",
    "tar",
    "C:\\Program Files\\Git\\usr\\bin\\tar.exe",
    "/usr/bin/gtar",
    "/opt/homebrew/opt/gnu-tar/libexec/gnubin/tar",
    "/usr/local/opt/gnu-tar/libexec/gnubin/tar",
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const probe = NodeChildProcess.spawnSync(candidate, ["--version"], { encoding: "utf8" });
    const text = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
    if (probe.status === 0 && isGnuTarVersion(text)) return candidate;
  }
  throw new Error(
    "GNU tar is required (--sort/--mtime/--owner). Install it (macOS: brew install gnu-tar) or set LHC_ARCHIVE_TAR. Windows Git usr/bin/tar.exe is GNU; System32 tar is not.",
  );
}

function archivePathNeedsForceLocal(archivePath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(archivePath);
}

/** The staged node-pty prebuilt spawn-helper lacked execute mode. */
function restoreDarwinSpawnHelperMode(stage: string): void {
  const helper = NodePath.join(
    stage,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  if (!NodeFS.existsSync(helper)) {
    throw new Error(`darwin spawn-helper missing at ${helper}`);
  }
  NodeFS.chmodSync(helper, 0o755);
}

function proveDarwinPtySpawn(extractedRoot: string): void {
  const helper = NodePath.join(
    extractedRoot,
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  const mode = NodeFS.statSync(helper).mode & 0o111;
  if (mode === 0) {
    throw new Error(`extracted spawn-helper is not executable (${helper})`);
  }
  const script = `
    const pty = require("node-pty");
    const term = pty.spawn("/bin/sh", ["-c", "printf ready"], { name: "xterm", cols: 40, rows: 10 });
    let out = "";
    term.onData((d) => { out += d; });
    term.onExit(({ exitCode }) => {
      if (!out.includes("ready")) {
        console.error("pty spawn produced no output");
        process.exit(1);
      }
      process.exit(exitCode === 0 ? 0 : 1);
    });
  `;
  run(process.execPath, ["-e", script], extractedRoot);
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

/**
 * Install the recorded claude-lhc package (lhc core bundled inside it) and lay
 * it out as vendor/claude-lhc: the package itself at the root, so the entry is
 * vendor/claude-lhc/dist/sidecar.js as before, with its dependency closure
 * merged into vendor/claude-lhc/node_modules.
 */
function stageClaudeLhc(
  stage: string,
  pin: SidecarPin,
  tarball: string | undefined,
): SidecarProvenance {
  const sidecarRoot = NodePath.join(stage, LHC_SIDECAR_ARCHIVE_ROOT);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-lhc-sidecar-"));
  try {
    writePackageJson(NodePath.join(scratch, "package.json"), {
      name: "t3code-lhc-sidecar-stage",
      private: true,
      dependencies: { [pin.package]: sidecarInstallSpec(pin, tarball) },
    });
    console.log(`[lhc-archive] installing ${pin.package}@${pin.version} (${tarball ?? "npm"})...`);
    runNpm(["install", "--omit=dev", "--no-fund", "--no-audit", "--no-package-lock"], scratch);

    const modules = NodePath.join(scratch, "node_modules");
    const installed = NodePath.join(modules, pin.package);
    const pkg = readPackageJson(NodePath.join(installed, "package.json"));
    assertSidecarPackage(pkg, pin);
    NodeFS.cpSync(installed, sidecarRoot, { recursive: true, dereference: true });
    for (const entry of NodeFS.readdirSync(modules)) {
      if (entry === pin.package || entry === ".bin" || entry.startsWith(".package-lock")) continue;
      NodeFS.cpSync(
        NodePath.join(modules, entry),
        NodePath.join(sidecarRoot, "node_modules", entry),
        {
          recursive: true,
          dereference: true,
          force: false,
          errorOnExist: true,
        },
      );
    }
    removeBundledClaudeExecutables(NodePath.join(sidecarRoot, "node_modules"));
    if (!NodeFS.existsSync(NodePath.join(stage, LHC_SIDECAR_LAUNCHER))) {
      throw new Error(`${pin.package}@${pin.version} has no dist/sidecar.js`);
    }
    if (!NodeFS.existsSync(NodePath.join(sidecarRoot, "node_modules", "lhc", "package.json"))) {
      throw new Error(`${pin.package}@${pin.version} does not bundle the lhc core`);
    }
    const source =
      tarball === undefined
        ? "npm"
        : `tarball:${NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(tarball)).digest("hex")}`;
    return {
      package: pin.package,
      version: pin.version,
      claudeAgentSdk: claudeAgentSdkVersionFromPackage(pkg),
      source,
    };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function desktopPlatform(platform: ArchivePlatform): "linux" | "mac" | "win" {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "mac";
  return "win";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const [hostPlatform, hostArch] = Effect.runSync(
    Effect.all([HostProcessPlatform, HostProcessArchitecture]),
  );
  const platform: ArchivePlatform =
    options.platform ??
    (hostPlatform === "darwin" || hostPlatform === "win32" ? hostPlatform : "linux");
  const arch: ArchiveArch = options.arch ?? (hostArch === "arm64" ? "arm64" : "x64");
  if (isArchiveTarget(platform, arch) === undefined) {
    throw new Error(`unsupported archive target ${platform}-${arch}`);
  }
  const identity = { version: lhcVersion.version, upstreamTag: lhcVersion.upstreamTag };
  console.log(
    `[lhc-archive] npm ${runNpm(["--version"], repoRoot).trim()} at ${resolveArchiveNpm()}`,
  );

  if (!options.skipBuild) {
    console.log("[lhc-archive] building server (with web client)...");
    runVp(["run", "--filter", "t3", "build"], repoRoot);
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
    fffNativeDependencies: (a, version) =>
      resolveFffNativeDependencies(desktopPlatform(platform), a, version),
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
    NodeFS.mkdirSync(NodePath.join(stage, "scripts"), { recursive: true });
    for (const script of ARCHIVE_SCRIPTS) {
      const target = NodePath.join(stage, "scripts", script);
      NodeFS.copyFileSync(NodePath.join(repoRoot, "scripts", script), target);
      NodeFS.chmodSync(target, 0o755);
    }
    NodeFS.writeFileSync(
      NodePath.join(stage, "package.json"),
      `${JSON.stringify({ name: "t3code-lhc-server", version: identity.version, private: true, packageManager: rootPackageJson.packageManager, dependencies }, null, 2)}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(stage, "pnpm-workspace.yaml"),
      encodeYaml({
        ...createStageWorkspaceConfig({
          platform: desktopPlatform(platform),
          arch,
          allowBuilds: { ...workspace.allowBuilds },
          patchedDependencies,
          overrides,
        }),
        nodeLinker: "hoisted" as const,
      }),
    );
    if (Object.keys(patchedDependencies).length > 0) {
      NodeFS.cpSync(NodePath.join(repoRoot, "patches"), NodePath.join(stage, "patches"), {
        recursive: true,
      });
    }
    console.log("[lhc-archive] installing runtime dependency closure...");
    runVp([...STAGE_INSTALL_ARGS], stage);

    const pin: SidecarPin = sidecarPin;
    console.log(
      `[lhc-archive] staging ${LHC_SIDECAR_ARCHIVE_ROOT} from ${pin.package}@${pin.version}`,
    );
    const sidecar = stageClaudeLhc(stage, pin, options.sidecarTarball);

    const commit = run("git", ["rev-parse", "HEAD"], repoRoot).trim();
    const commitTime = Number(run("git", ["log", "-1", "--format=%ct", "HEAD"], repoRoot).trim());
    const manifest = buildManifest({
      identity,
      commit,
      platform,
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
    const name = archiveFileName({ version: identity.version, platform, arch });
    const archivePath = NodePath.join(outDir, name);
    NodeFS.rmSync(archivePath, { force: true });
    if (platform === "darwin") {
      restoreDarwinSpawnHelperMode(stage);
    }
    console.log(`[lhc-archive] packing ${name}`);
    const gnuTar = resolveGnuTar();
    run(
      gnuTar,
      tarArguments({
        archivePath,
        excludedPrefixes: archiveExcludedPrefixes(LHC_ARCHIVE_EXCLUDED_PREFIXES, platform),
        mtimeEpochSeconds: commitTime,
        forceLocal: archivePathNeedsForceLocal(archivePath),
      }),
      stage,
      withGnuTarPath(),
    );
    const digest = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(archivePath))
      .digest("hex");
    NodeFS.writeFileSync(`${archivePath}.sha256`, sha256Line(digest, name));

    // Post-pack check: the extracted tree must answer with its identity.
    const probe = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-lhc-probe-"));
    try {
      run(
        gnuTar,
        tarExtractArguments({
          archivePath,
          forceLocal: archivePathNeedsForceLocal(archivePath),
        }),
        probe,
        withGnuTarPath(),
      );
      const expected = expectedLhcVersionLine(identity);
      const hostMatchesArchive =
        (hostPlatform === "linux" && platform === "linux") ||
        (hostPlatform === "darwin" && platform === "darwin") ||
        (hostPlatform === "win32" && platform === "win32");
      if (hostMatchesArchive) {
        const printed = run("node", ["apps/server/dist/bin.mjs", "--lhc-version"], probe, {
          NODE_OPTIONS: "",
        }).trim();
        if (printed !== expected)
          throw new Error(`post-pack identity check failed: got "${printed}", want "${expected}"`);
        if (platform === "darwin") proveDarwinPtySpawn(probe);
      } else {
        console.log(
          `[lhc-archive] skipping live --lhc-version on ${hostPlatform} for ${platform} archive`,
        );
      }
      if (!NodeFS.existsSync(NodePath.join(probe, "apps/server/dist/client/index.html"))) {
        throw new Error("post-pack check failed: web client missing from the archive");
      }
      for (const script of ARCHIVE_SCRIPTS) {
        const packed = NodePath.join(probe, "scripts", script);
        if (!NodeFS.existsSync(packed)) {
          throw new Error(`post-pack check failed: scripts/${script} missing from the archive`);
        }
        if (hostPlatform !== "win32" && (NodeFS.statSync(packed).mode & 0o111) === 0) {
          throw new Error(`post-pack check failed: scripts/${script} is not executable`);
        }
      }
      if (platform === "win32") {
        const ffi = NodePath.join(probe, "node_modules", "@yuuang", "ffi-rs-win32-x64-msvc");
        const fff = NodePath.join(probe, "node_modules", "@ff-labs", "fff-bin-win32-x64");
        if (!NodeFS.existsSync(ffi)) {
          throw new Error("post-pack check failed: @yuuang/ffi-rs-win32-x64-msvc missing");
        }
        if (!NodeFS.existsSync(fff)) {
          throw new Error("post-pack check failed: @ff-labs/fff-bin-win32-x64 missing");
        }
      }
      if (platform === "darwin") {
        const helper = NodePath.join(
          probe,
          "node_modules",
          "node-pty",
          "prebuilds",
          "darwin-arm64",
          "spawn-helper",
        );
        if ((NodeFS.statSync(helper).mode & 0o111) === 0) {
          throw new Error("post-pack check failed: darwin spawn-helper is not executable");
        }
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
      assertSidecarPackage(sidecarPkg, sidecar);
      const packedLhc = NodePath.join(probe, LHC_SIDECAR_ARCHIVE_ROOT, "node_modules", "lhc");
      const packedLhcReal = NodeFS.realpathSync(packedLhc);
      const probeReal = NodeFS.realpathSync(probe);
      if (!packedLhcResolvesInsideArchive(packedLhcReal, probeReal)) {
        throw new Error(
          `post-pack check failed: node_modules/lhc resolves outside the archive (${packedLhcReal})`,
        );
      }
      if (!NodeFS.existsSync(NodePath.join(packedLhcReal, "package.json"))) {
        throw new Error("post-pack check failed: packed lhc has no package.json");
      }
      const anthropic = NodePath.join(
        probe,
        LHC_SIDECAR_ARCHIVE_ROOT,
        "node_modules",
        "@anthropic-ai",
      );
      if (NodeFS.existsSync(anthropic)) {
        for (const entry of NodeFS.readdirSync(anthropic)) {
          if (isBundledClaudeExecutablePackage(entry)) {
            throw new Error(`post-pack check failed: optional SDK Claude binary packed (${entry})`);
          }
        }
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
