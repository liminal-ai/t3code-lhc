// Store helpers for scripts/install-lhc.sh. Windows Git Bash `ln -s` copies a
// directory instead of linking (LinkType=null). Node is already required, so
// current is a directory junction on win32 and a POSIX symlink elsewhere.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

export function isWindowsStoreHost(platform = process.platform) {
  return platform === "win32";
}

export function currentLinkTarget(version) {
  return NodePath.join("versions", version);
}

/** Windows junctions resolve relative targets against cwd, not the link dirname. */
export function windowsJunctionTarget(prefix, version) {
  return NodePath.resolve(prefix, "versions", version);
}

export function swapCurrent(input) {
  const platform = input.platform ?? process.platform;
  const prefix = NodePath.resolve(input.prefix);
  const current = NodePath.join(prefix, "current");
  const staging = `${current}.${process.pid}.tmp`;
  NodeFS.rmSync(staging, { recursive: true, force: true });
  if (isWindowsStoreHost(platform)) {
    NodeFS.symlinkSync(windowsJunctionTarget(prefix, input.version), staging, "junction");
  } else {
    NodeFS.symlinkSync(currentLinkTarget(input.version), staging);
  }
  NodeFS.rmSync(current, { recursive: true, force: true });
  NodeFS.renameSync(staging, current);
}

export function readCurrentVersion(prefix) {
  const current = NodePath.join(prefix, "current");
  try {
    const linked = NodeFS.readlinkSync(current);
    const base = NodePath.basename(linked.replaceAll("\\", "/"));
    return base.length > 0 ? base : null;
  } catch {
    return null;
  }
}

function main() {
  const [command, prefix, version] = process.argv.slice(2);
  if (command === "swap-current") {
    if (prefix === undefined || version === undefined) {
      throw new Error("usage: lhc-store.mjs swap-current <prefix> <version>");
    }
    swapCurrent({ prefix, version });
    return;
  }
  if (command === "read-current") {
    if (prefix === undefined) throw new Error("usage: lhc-store.mjs read-current <prefix>");
    process.stdout.write(readCurrentVersion(prefix) ?? "");
    return;
  }
  throw new Error(`unknown lhc-store command ${command ?? ""}`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  main();
}
