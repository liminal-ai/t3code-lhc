// @effect-diagnostics nodeBuiltinImport:off
// Store helpers for scripts/install-lhc.sh. Windows Git Bash `ln -s` copies a
// directory instead of linking (LinkType=null). Node is already required, so
// current is a directory junction on win32 and a POSIX symlink elsewhere.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function isWindowsStoreHost(platform: string): boolean {
  return platform === "win32";
}

export function currentLinkTarget(version: string): string {
  return NodePath.join("versions", version);
}

export function swapCurrent(input: {
  readonly prefix: string;
  readonly version: string;
  readonly platform?: string;
}): void {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Bash-invoked store helper has no Effect runtime.
  const platform = input.platform ?? process.platform;
  const current = NodePath.join(input.prefix, "current");
  const target = currentLinkTarget(input.version);
  const staging = `${current}.${process.pid}.tmp`;
  NodeFS.rmSync(staging, { recursive: true, force: true });
  if (isWindowsStoreHost(platform)) {
    NodeFS.symlinkSync(target, staging, "junction");
  } else {
    NodeFS.symlinkSync(target, staging);
  }
  NodeFS.rmSync(current, { recursive: true, force: true });
  NodeFS.renameSync(staging, current);
}

export function readCurrentVersion(prefix: string): string | null {
  const current = NodePath.join(prefix, "current");
  try {
    const linked = NodeFS.readlinkSync(current);
    const base = NodePath.basename(linked.replaceAll("\\", "/"));
    return base.length > 0 ? base : null;
  } catch {
    return null;
  }
}

function main(): void {
  const [command, prefix, version] = process.argv.slice(2);
  if (command === "swap-current") {
    if (prefix === undefined || version === undefined) {
      throw new Error("usage: lhc-store.ts swap-current <prefix> <version>");
    }
    swapCurrent({ prefix, version });
    return;
  }
  if (command === "read-current") {
    if (prefix === undefined) throw new Error("usage: lhc-store.ts read-current <prefix>");
    process.stdout.write(readCurrentVersion(prefix) ?? "");
    return;
  }
  throw new Error(`unknown lhc-store command ${command ?? ""}`);
}

if (
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  main();
}
