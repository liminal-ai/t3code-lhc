// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";

import {
  ARCHIVE_ROOTS,
  archiveFileName,
  archiveVersionFromFileName,
  buildManifest,
  expectedLhcVersionLine,
  sha256Line,
  stageDependencies,
  tarArguments,
} from "./lhc-archive.ts";

describe("lhc-archive", () => {
  it("names the archive for version, platform and arch, and parses it back", () => {
    const name = archiveFileName({ version: "0.0.40-lhc.3", platform: "linux", arch: "x64" });
    expect(name).toBe("t3code-lhc-0.0.40-lhc.3-linux-x64.tar.gz");
    expect(archiveVersionFromFileName(name, "linux", "x64")).toBe("0.0.40-lhc.3");
    expect(archiveVersionFromFileName(name, "linux", "arm64")).toBeNull();
    expect(archiveFileName({ version: "0.0.40-lhc.3", platform: "darwin", arch: "arm64" })).toBe(
      "t3code-lhc-0.0.40-lhc.3-darwin-arm64.tar.gz",
    );
    expect(archiveFileName({ version: "0.0.40-lhc.3", platform: "win32", arch: "x64" })).toBe(
      "t3code-lhc-0.0.40-lhc.3-win32-x64.tar.gz",
    );
    expect(archiveVersionFromFileName("t3code-lhc--linux-x64.tar.gz", "linux", "x64")).toBeNull();
    expect(archiveVersionFromFileName("t3-0.0.40-linux-x64.tar.gz", "linux", "x64")).toBeNull();
  });

  it("formats the identity line the CLI prints", () => {
    expect(expectedLhcVersionLine({ version: "0.0.40", upstreamTag: "v0.0.40" })).toBe(
      "t3code-lhc 0.0.40 (upstream v0.0.40)",
    );
  });

  it("builds a manifest carrying identity, commit, target, roots and sidecar pin", () => {
    const sidecar = {
      repository: "https://github.com/liminal-ai/long-horizon-context.git",
      commit: "1ba4cee9768514aa7358e8dba5f69b5c108dcdae",
      claudeAgentSdk: "0.3.170",
    };
    const manifest = buildManifest({
      identity: { version: "0.0.40-lhc.3", upstreamTag: "v0.0.40" },
      commit: "bd6f0161f",
      platform: "linux",
      arch: "x64",
      nodeEngine: "^24.13.1",
      sidecar,
    });
    expect(manifest).toEqual({
      name: "t3code-lhc-0.0.40-lhc.3-linux-x64.tar.gz",
      version: "0.0.40-lhc.3",
      upstreamTag: "v0.0.40",
      commit: "bd6f0161f",
      platform: "linux",
      arch: "x64",
      node: "^24.13.1",
      roots: ["manifest.json", "apps/server/dist", "node_modules", "vendor/claude-lhc"],
      sidecar,
    });
    expect("createdAt" in manifest).toBe(false);
  });

  it("stages only runtime externals plus the linux fff natives, catalog resolved", () => {
    const deps = stageDependencies({
      serverDependencies: {
        "node-pty": "^1.1.0",
        "@ff-labs/fff-node": "catalog:",
        "msgpackr-extract": "3.0.4",
        effect: "catalog:",
        "@t3tools/contracts": "workspace:*",
      },
      catalog: { "@ff-labs/fff-node": "0.9.4", effect: "4.0.0" },
      arch: "x64",
      fffNativeDependencies: (arch, version) => ({
        [`@ff-labs/fff-bin-linux-${arch}-gnu`]: version,
      }),
    });
    expect(deps).toEqual({
      "node-pty": "^1.1.0",
      "@ff-labs/fff-node": "0.9.4",
      "msgpackr-extract": "3.0.4",
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
    });
    expect(() =>
      stageDependencies({
        serverDependencies: { "node-pty": "^1.1.0" },
        catalog: {},
        arch: "x64",
        fffNativeDependencies: () => ({}),
      }),
    ).toThrow(/fff-node/);
  });

  it("emits reproducible tar arguments: pinned mtime, gzip -n, maps and shared prefixes excluded", () => {
    const args = tarArguments({
      archivePath: "/out/a.tar.gz",
      excludedPrefixes: ["node_modules/.pnpm", "node_modules/node-pty/prebuilds/darwin-"],
      mtimeEpochSeconds: 1788400000,
    });
    expect(args).toEqual([
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mtime=@1788400000",
      "--use-compress-program=gzip -n",
      "--exclude=*.map",
      "--exclude=node_modules/.pnpm*",
      "--exclude=node_modules/node-pty/prebuilds/darwin-*",
      "-cf",
      "/out/a.tar.gz",
      ...ARCHIVE_ROOTS,
    ]);
    expect(() =>
      tarArguments({ archivePath: "/out/a.tar.gz", excludedPrefixes: [], mtimeEpochSeconds: 1.5 }),
    ).toThrow(/non-negative integer/);
  });

  it("rewrites only workspace: specs onto file: bindings", async () => {
    const { rewriteWorkspaceDependencies, packageJsonWithWorkspaceRewrites } =
      await import("./lhc-sidecar-stage.ts");
    expect(
      rewriteWorkspaceDependencies(
        {
          lhc: "workspace:*",
          zod: "4.4.3",
          "@anthropic-ai/claude-agent-sdk": "0.3.170",
        },
        { lhc: "file:./lhc" },
      ),
    ).toEqual({
      lhc: "file:./lhc",
      zod: "4.4.3",
      "@anthropic-ai/claude-agent-sdk": "0.3.170",
    });
    expect(() =>
      rewriteWorkspaceDependencies({ other: "workspace:*" }, { lhc: "file:./lhc" }),
    ).toThrow(/other/);
    expect(
      packageJsonWithWorkspaceRewrites(
        {
          name: "claude-lhc",
          version: "0.1.0",
          dependencies: { lhc: "workspace:*", zod: "4.4.3" },
        },
        { lhc: "file:./lhc" },
      ),
    ).toEqual({
      name: "claude-lhc",
      version: "0.1.0",
      dependencies: { lhc: "file:./lhc", zod: "4.4.3" },
    });
  });

  it("writes sha256sum-compatible lines", () => {
    expect(sha256Line("ab".repeat(32), "x.tar.gz")).toBe(`${"ab".repeat(32)}  x.tar.gz\n`);
  });
});

describe("archiveExcludedPrefixes", () => {
  it("keeps node-pty's compiled binary while dropping the shared list's other prefixes", async () => {
    const { archiveExcludedPrefixes } = await import("./lhc-archive.ts");
    const shared = [
      "node_modules/.pnpm",
      "node_modules/node-pty/build",
      "node_modules/node-pty/prebuilds/win32-",
    ];
    const result = archiveExcludedPrefixes(shared, "linux");
    expect(result).not.toContain("node_modules/node-pty/build");
    expect(result).toContain("node_modules/.pnpm");
    expect(result).toContain("node_modules/node-pty/prebuilds/win32-");
    expect(result).toContain("node_modules/node-pty/build/Release/obj");
    expect(result).toContain("vendor/claude-lhc/node_modules/@anthropic-ai/claude-agent-sdk-");
    const darwin = archiveExcludedPrefixes(shared, "darwin");
    expect(darwin).toContain("node_modules/node-pty/build");
    expect(darwin).not.toContain("node_modules/node-pty/prebuilds/darwin-");
    const win = archiveExcludedPrefixes(shared, "win32");
    expect(win).not.toContain("node_modules/node-pty/prebuilds/win32-");
    expect(win).not.toContain("node_modules/node-pty/third_party/conpty");
    expect(
      result.every((prefix) => !"node_modules/node-pty/build/Release/pty.node".startsWith(prefix)),
    ).toBe(true);
  });
});
