import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  currentLinkTarget,
  readCurrentVersion,
  swapCurrent,
  windowsJunctionTarget,
} from "./lhc-store.mjs";

describe("lhc-store", () => {
  it("names the relative current target as versions/<version>", () => {
    expect(currentLinkTarget("0.0.40-lhc.3")).toBe(NodePath.join("versions", "0.0.40-lhc.3"));
  });

  it("uses an absolute Windows junction target under the store prefix, not cwd", () => {
    const prefix = NodePath.resolve("/tmp/t3code-lhc-store");
    expect(windowsJunctionTarget(prefix, "0.0.40-lhc.3")).toBe(
      NodePath.resolve(prefix, "versions", "0.0.40-lhc.3"),
    );
    expect(windowsJunctionTarget(prefix, "0.0.40-lhc.3")).not.toBe(
      NodePath.join("versions", "0.0.40-lhc.3"),
    );
  });

  it("swaps current onto a new version and rollback follows the new marker", () => {
    const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-store-"));
    try {
      NodeFS.mkdirSync(NodePath.join(prefix, "versions", "0.0.40"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(prefix, "versions", "0.0.41-lhc.1"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(prefix, "versions", "0.0.40", "marker"), "a");
      NodeFS.writeFileSync(NodePath.join(prefix, "versions", "0.0.41-lhc.1", "marker"), "b");
      swapCurrent({ prefix, version: "0.0.40" });
      expect(readCurrentVersion(prefix)).toBe("0.0.40");
      expect(NodeFS.readFileSync(NodePath.join(prefix, "current", "marker"), "utf8")).toBe("a");
      swapCurrent({ prefix, version: "0.0.41-lhc.1" });
      expect(readCurrentVersion(prefix)).toBe("0.0.41-lhc.1");
      expect(NodeFS.readFileSync(NodePath.join(prefix, "current", "marker"), "utf8")).toBe("b");
      NodeFS.writeFileSync(NodePath.join(prefix, "versions", "0.0.40", "marker"), "changed");
      expect(NodeFS.readFileSync(NodePath.join(prefix, "current", "marker"), "utf8")).toBe("b");
    } finally {
      NodeFS.rmSync(prefix, { recursive: true, force: true });
    }
  });
});
