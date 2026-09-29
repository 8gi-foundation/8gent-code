import path from "node:path";
import { fromLongPath } from "./win-path";

/** The `node:path` flavour whose separator and root rules match `platform`. */
export function pathFor(platform: NodeJS.Platform = process.platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * `true` iff absolute path `child` is `root` or lies beneath it.
 *
 * On win32 the comparison ignores case (NTFS lookups do), accepts either
 * separator, and treats `\\?\C:\x` as `C:\x`, so a spelling of the same
 * location never reads as a different one. A path on another drive or share
 * is never inside. A sibling that merely shares a string prefix
 * (`/ws-other` against `/ws`) is never inside on any platform.
 */
export function isPathWithin(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = pathFor(platform);
  const canonical = (s: string) => {
    const resolved = p.resolve(fromLongPath(s, platform));
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = p.relative(canonical(root), canonical(child));
  if (rel === "") return true;
  if (p.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${p.sep}`);
}
