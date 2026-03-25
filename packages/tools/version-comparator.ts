/**
 * Semantic version comparator and range checker.
 * Parses semver strings, compares versions, sorts arrays,
 * checks range satisfaction, and bumps versions.
 *
 * Supports: ^, ~, >=, <=, >, <, = range operators.
 * Supports pre-release identifiers (alpha, beta, rc, etc).
 */

export type BumpType = "major" | "minor" | "patch" | "premajor" | "preminor" | "prepatch" | "prerelease";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  preRelease: string[];
  buildMeta: string;
  raw: string;
}

function parse(version: string): ParsedVersion | null {
  const trimmed = version.trim().replace(/^v/, "");
  const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9._-]+))?(?:\+([a-zA-Z0-9._-]+))?$/;
  const match = trimmed.match(pattern);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    preRelease: match[4] ? match[4].split(".") : [],
    buildMeta: match[5] ?? "",
    raw: trimmed,
  };
}

function comparePreRelease(a: string[], b: string[]): number {
  // No pre-release > has pre-release (1.0.0 > 1.0.0-alpha)
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;

    const aField = a[i];
    const bField = b[i];
    const aNum = parseInt(aField, 10);
    const bNum = parseInt(bField, 10);
    const aIsNum = !isNaN(aNum);
    const bIsNum = !isNaN(bNum);

    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum < bNum ? -1 : 1;
    } else if (aIsNum) {
      return -1; // numeric < alphanumeric
    } else if (bIsNum) {
      return 1;
    } else {
      const cmp = aField.localeCompare(bField);
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two semver strings.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 * Throws if either string is not valid semver.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa) throw new Error(`Invalid semver: "${a}"`);
  if (!pb) throw new Error(`Invalid semver: "${b}"`);

  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePreRelease(pa.preRelease, pb.preRelease) as -1 | 0 | 1;
}

/**
 * Sort an array of semver strings in ascending order (lowest first).
 * Returns a new array - does not mutate the input.
 */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => compareVersions(a, b));
}

/**
 * Check whether a version satisfies a range expression.
 * Supported operators: ^, ~, >=, <=, >, <, = (or bare version for equality).
 */
export function satisfies(version: string, range: string): boolean {
  const trimmedRange = range.trim();

  // Space-separated AND conditions (e.g. ">=1.0.0 <2.0.0")
  if (/\s+/.test(trimmedRange) && !trimmedRange.startsWith("^") && !trimmedRange.startsWith("~")) {
    return trimmedRange.split(/\s+/).every((r) => satisfies(version, r));
  }

  const pv = parse(version);
  if (!pv) throw new Error(`Invalid semver: "${version}"`);

  if (trimmedRange.startsWith("^")) {
    const base = parse(trimmedRange.slice(1));
    if (!base) throw new Error(`Invalid range: "${range}"`);
    if (base.major !== 0) {
      return pv.major === base.major && compareVersions(version, base.raw) >= 0;
    } else if (base.minor !== 0) {
      return pv.major === 0 && pv.minor === base.minor && compareVersions(version, base.raw) >= 0;
    } else {
      return pv.major === 0 && pv.minor === 0 && pv.patch === base.patch;
    }
  }

  if (trimmedRange.startsWith("~")) {
    const base = parse(trimmedRange.slice(1));
    if (!base) throw new Error(`Invalid range: "${range}"`);
    return pv.major === base.major && pv.minor === base.minor && compareVersions(version, base.raw) >= 0;
  }

  if (trimmedRange.startsWith(">=")) return compareVersions(version, trimmedRange.slice(2).trim()) >= 0;
  if (trimmedRange.startsWith("<=")) return compareVersions(version, trimmedRange.slice(2).trim()) <= 0;
  if (trimmedRange.startsWith(">")) return compareVersions(version, trimmedRange.slice(1).trim()) > 0;
  if (trimmedRange.startsWith("<")) return compareVersions(version, trimmedRange.slice(1).trim()) < 0;
  if (trimmedRange.startsWith("=")) return compareVersions(version, trimmedRange.slice(1).trim()) === 0;

  // Bare version - exact equality
  return compareVersions(version, trimmedRange) === 0;
}

/**
 * Bump a semver string.
 * Types: major, minor, patch, premajor, preminor, prepatch, prerelease.
 * Pre-* bumps append or increment a numeric pre-release identifier.
 */
export function bumpVersion(version: string, type: BumpType, preReleaseId = "0"): string {
  const pv = parse(version);
  if (!pv) throw new Error(`Invalid semver: "${version}"`);

  let { major, minor, patch, preRelease } = pv;

  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "premajor":
      return `${major + 1}.0.0-${preReleaseId}.0`;
    case "preminor":
      return `${major}.${minor + 1}.0-${preReleaseId}.0`;
    case "prepatch":
      return `${major}.${minor}.${patch + 1}-${preReleaseId}.0`;
    case "prerelease": {
      if (preRelease.length === 0) {
        return `${major}.${minor}.${patch}-${preReleaseId}.0`;
      }
      const last = preRelease[preRelease.length - 1];
      const lastNum = parseInt(last, 10);
      if (!isNaN(lastNum)) {
        preRelease = [...preRelease.slice(0, -1), String(lastNum + 1)];
      } else {
        preRelease = [...preRelease, "0"];
      }
      return `${major}.${minor}.${patch}-${preRelease.join(".")}`;
    }
  }
}
