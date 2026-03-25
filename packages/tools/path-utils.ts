/**
 * Cross-platform path manipulation utilities.
 * Pure functions - no filesystem access, no Node/Bun deps.
 * Works on POSIX and Windows paths.
 */

/** Ensure a path ends with a forward slash. */
export function ensureTrailingSlash(path: string): string {
  if (!path) return "/";
  return path.endsWith("/") ? path : path + "/";
}

/** Remove trailing slash(es) from a path, except for root "/". */
export function removeTrailingSlash(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

/** Normalize all backslashes to forward slashes and collapse duplicate slashes. */
export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** Return true if the path is absolute (starts with "/" or a Windows drive like "C:\"). */
export function isAbsolute(path: string): boolean {
  return /^(?:[A-Za-z]:[/\\]|\/)/.test(path);
}

/** Return true if the path is relative (not absolute). */
export function isRelative(path: string): boolean {
  return !isAbsolute(path);
}

/**
 * Compute the relative path from `from` to `to`.
 * Both inputs are treated as directory paths (not file paths).
 * Returns a POSIX-style relative path.
 *
 * @example relativeTo("/a/b/c", "/a/b/d/e") => "../d/e"
 */
export function relativeTo(from: string, to: string): string {
  const fromParts = normalizeSlashes(from).split("/").filter(Boolean);
  const toParts = normalizeSlashes(to).split("/").filter(Boolean);

  let common = 0;
  while (common < fromParts.length && fromParts[common] === toParts[common]) {
    common++;
  }

  const upCount = fromParts.length - common;
  const downParts = toParts.slice(common);
  const parts = [...Array(upCount).fill(".."), ...downParts];

  return parts.length === 0 ? "." : parts.join("/");
}

/**
 * Find the longest common prefix shared by all given paths.
 * Returns an empty string if there is no common prefix.
 *
 * @example commonPrefix(["/a/b/c", "/a/b/d"]) => "/a/b"
 */
export function commonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) return paths[0];

  const normalized = paths.map((p) => normalizeSlashes(p).split("/").filter(Boolean));

  const shortest = Math.min(...normalized.map((p) => p.length));
  const segments: string[] = [];

  for (let i = 0; i < shortest; i++) {
    const segment = normalized[0][i];
    if (normalized.every((p) => p[i] === segment)) {
      segments.push(segment);
    } else {
      break;
    }
  }

  if (segments.length === 0) return "";
  return "/" + segments.join("/");
}

/**
 * Return the path with its extension replaced (or added if none exists).
 * The `ext` parameter should include the leading dot, e.g. ".ts".
 *
 * @example withExtension("src/foo.js", ".ts") => "src/foo.ts"
 */
export function withExtension(path: string, ext: string): string {
  const normalized = normalizeSlashes(path);
  const slashIdx = normalized.lastIndexOf("/");
  const filename = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
  const dotIdx = filename.lastIndexOf(".");

  const base = dotIdx === -1 ? normalized : normalized.slice(0, normalized.lastIndexOf("."));
  const newExt = ext.startsWith(".") ? ext : "." + ext;
  return base + newExt;
}

/**
 * Return the path with its extension removed.
 *
 * @example withoutExtension("src/foo.ts") => "src/foo"
 */
export function withoutExtension(path: string): string {
  const normalized = normalizeSlashes(path);
  const slashIdx = normalized.lastIndexOf("/");
  const filename = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
  const dotIdx = filename.lastIndexOf(".");

  if (dotIdx === -1) return normalized;
  return normalized.slice(0, normalized.lastIndexOf("."));
}

/**
 * Split a path into its constituent segments, filtering out empty strings.
 * Works with both POSIX and Windows paths.
 *
 * @example splitPath("/a/b/c") => ["a", "b", "c"]
 * @example splitPath("C:\\foo\\bar") => ["C:", "foo", "bar"]
 */
export function splitPath(path: string): string[] {
  return normalizeSlashes(path).split("/").filter(Boolean);
}
