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

    const commit = run("git", ["rev-parse", "HEAD"], repoRoot).trim();
    const commitTime = Number(run("git", ["log", "-1", "--format=%ct", "HEAD"], repoRoot).trim());
    const manifest = buildManifest({
      identity,
      commit,
      platform: "linux",
      arch,
      nodeEngine: rootPackageJson.engines.node,
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
