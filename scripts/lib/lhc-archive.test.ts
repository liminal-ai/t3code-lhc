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
    const name = archiveFileName({ version: "0.0.40-lhc.2", platform: "linux", arch: "x64" });
    expect(name).toBe("t3code-lhc-0.0.40-lhc.2-linux-x64.tar.gz");
    expect(archiveVersionFromFileName(name, "linux", "x64")).toBe("0.0.40-lhc.2");
    expect(archiveVersionFromFileName(name, "linux", "arm64")).toBeNull();
    expect(archiveVersionFromFileName("t3code-lhc--linux-x64.tar.gz", "linux", "x64")).toBeNull();
    expect(archiveVersionFromFileName("t3-0.0.40-linux-x64.tar.gz", "linux", "x64")).toBeNull();
  });

  it("formats the identity line the CLI prints", () => {
    expect(expectedLhcVersionLine({ version: "0.0.40", upstreamTag: "v0.0.40" })).toBe(
      "t3code-lhc 0.0.40 (upstream v0.0.40)",
    );
  });

  it("builds a manifest carrying identity, commit, target and roots", () => {
    const manifest = buildManifest({
      identity: { version: "0.0.40", upstreamTag: "v0.0.40" },
      commit: "bd6f0161f",
      platform: "linux",
      arch: "x64",
      nodeEngine: "^24.13.1",
      createdAt: new Date("2026-09-09T02:00:00Z"),
    });
    expect(manifest).toEqual({
      name: "t3code-lhc-0.0.40-linux-x64.tar.gz",
      version: "0.0.40",
      upstreamTag: "v0.0.40",
      commit: "bd6f0161f",
      platform: "linux",
      arch: "x64",
      node: "^24.13.1",
      createdAt: "2026-09-09T02:00:00.000Z",
      roots: ["manifest.json", "apps/server/dist", "node_modules"],
    });
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
      linuxFffNativeDependencies: (arch, version) => ({
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
        linuxFffNativeDependencies: () => ({}),
      }),
    ).toThrow(/fff-node/);
  });

  it("emits deterministic tar arguments with maps and the shared prefixes excluded", () => {
    const args = tarArguments({
      archivePath: "/out/a.tar.gz",
      excludedPrefixes: ["node_modules/.pnpm", "node_modules/node-pty/prebuilds/darwin-"],
    });
    expect(args).toEqual([
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--exclude=*.map",
      "--exclude=node_modules/.pnpm*",
      "--exclude=node_modules/node-pty/prebuilds/darwin-*",
      "-czf",
      "/out/a.tar.gz",
      ...ARCHIVE_ROOTS,
    ]);
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
    const result = archiveExcludedPrefixes(shared);
    expect(result).not.toContain("node_modules/node-pty/build");
    expect(result).toContain("node_modules/.pnpm");
    expect(result).toContain("node_modules/node-pty/prebuilds/win32-");
    expect(result).toContain("node_modules/node-pty/build/Release/obj");
    expect(
      result.every((prefix) => !"node_modules/node-pty/build/Release/pty.node".startsWith(prefix)),
    ).toBe(true);
  });
});
