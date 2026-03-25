/**
 * Zero-dependency semver parser, comparator, range matcher, sorter, and bumper.
 * Follows the Semantic Versioning 2.0.0 spec (https://semver.org/).
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  buildmetadata: string[];
  raw: string;
}

export type ReleaseType = "major" | "minor" | "patch" | "premajor" | "preminor" | "prepatch" | "prerelease";
export type CompareResult = -1 | 0 | 1;

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parse(version: string): SemVer | null {
  if (typeof version !== "string") return null;
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".") : [],
    buildmetadata: match[5] ? match[5].split(".") : [],
    raw: version.trim(),
  };
}

export function parseStrict(version: string): SemVer {
  const result = parse(version);
  if (!result) throw new Error(`Invalid semver: "${version}"`);
  return result;
}

export function valid(version: string): boolean {
  return parse(version) !== null;
}

export function stringify(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease.length > 0) s += `-${v.prerelease.join(".")}`;
  if (v.buildmetadata.length > 0) s += `+${v.buildmetadata.join(".")}`;
  return s;
}

function comparePrerelease(a: string[], b: string[]): CompareResult {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const ai = a[i];
    const bi = b[i];
    if (ai === bi) continue;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const d = parseInt(ai, 10) - parseInt(bi, 10);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (aIsNum) {
      return -1;
    } else if (bIsNum) {
      return 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return 0;
}

export function compare(a: string, b: string): CompareResult {
  const av = parseStrict(a);
  const bv = parseStrict(b);
  if (av.major !== bv.major) return av.major > bv.major ? 1 : -1;
  if (av.minor !== bv.minor) return av.minor > bv.minor ? 1 : -1;
  if (av.patch !== bv.patch) return av.patch > bv.patch ? 1 : -1;
  return comparePrerelease(av.prerelease, bv.prerelease);
}

export function gt(a: string, b: string): boolean { return compare(a, b) === 1; }
export function gte(a: string, b: string): boolean { return compare(a, b) >= 0; }
export function lt(a: string, b: string): boolean { return compare(a, b) === -1; }
export function lte(a: string, b: string): boolean { return compare(a, b) <= 0; }
export function eq(a: string, b: string): boolean { return compare(a, b) === 0; }
export function neq(a: string, b: string): boolean { return compare(a, b) !== 0; }

type Comparator = (v: SemVer) => boolean;

function parseComparator(raw: string): Comparator {
  const s = raw.trim();
  if (s === "*" || s === "x" || s === "") return () => true;

  const hyphenMatch = /^(.+?)\s+-\s+(.+)$/.exec(s);
  if (hyphenMatch) {
    const lo = parseStrict(hyphenMatch[1]);
    const hi = parseStrict(hyphenMatch[2]);
    return (v) => compare(stringify(v), stringify(lo)) >= 0 && compare(stringify(v), stringify(hi)) <= 0;
  }

  if (s.startsWith("~")) {
    const parts = s.slice(1).trim().split(".").filter((p) => p !== "x" && p !== "X" && p !== "*");
    if (parts.length >= 3) {
      const lo = parseStrict(`${parts[0]}.${parts[1]}.${parts[2]}`);
      const hi: SemVer = { ...lo, minor: lo.minor + 1, patch: 0, prerelease: [], buildmetadata: [], raw: "" };
      return (v) => compare(stringify(v), stringify(lo)) >= 0 && compare(stringify(v), stringify(hi)) < 0;
    }
    if (parts.length === 2) {
      const lo = parseStrict(`${parts[0]}.${parts[1]}.0`);
      const hi: SemVer = { ...lo, minor: lo.minor + 1, patch: 0, prerelease: [], buildmetadata: [], raw: "" };
      return (v) => compare(stringify(v), stringify(lo)) >= 0 && compare(stringify(v), stringify(hi)) < 0;
    }
    if (parts.length === 1) {
      const lo = parseStrict(`${parts[0]}.0.0`);
      const hi: SemVer = { ...lo, major: lo.major + 1, minor: 0, patch: 0, prerelease: [], buildmetadata: [], raw: "" };
      return (v) => compare(stringify(v), stringify(lo)) >= 0 && compare(stringify(v), stringify(hi)) < 0;
    }
    return () => false;
  }

  if (s.startsWith("^")) {
    const v = parseStrict(s.slice(1).trim().replace(/\.x/g, ".0").replace(/^x/, "0"));
    let hi: SemVer;
    if (v.major !== 0) {
      hi = { ...v, major: v.major + 1, minor: 0, patch: 0, prerelease: [], buildmetadata: [], raw: "" };
    } else if (v.minor !== 0) {
      hi = { ...v, minor: v.minor + 1, patch: 0, prerelease: [], buildmetadata: [], raw: "" };
    } else {
      hi = { ...v, patch: v.patch + 1, prerelease: [], buildmetadata: [], raw: "" };
    }
    return (v2) => compare(stringify(v2), stringify(v)) >= 0 && compare(stringify(v2), stringify(hi)) < 0;
  }

  const opMatch = /^(>=|<=|!=|>|<|=)(.+)$/.exec(s);
  if (opMatch) {
    const op = opMatch[1];
    const target = parseStrict(opMatch[2].trim());
    const ts = stringify(target);
    return (v) => {
      const cmp = compare(stringify(v), ts);
      switch (op) {
        case ">": return cmp === 1;
        case ">=": return cmp >= 0;
        case "<": return cmp === -1;
        case "<=": return cmp <= 0;
        case "!=": return cmp !== 0;
        case "=": return cmp === 0;
        default: return false;
      }
    };
  }

  const wcMatch = /^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(x|X|\*))?$/.exec(s);
  if (wcMatch) {
    const major = parseInt(wcMatch[1], 10);
    const minorRaw = wcMatch[2];
    if (!minorRaw || minorRaw === "x" || minorRaw === "X" || minorRaw === "*") return (v) => v.major === major;
    const minor = parseInt(minorRaw, 10);
    if (!wcMatch[3]) return (v) => v.major === major && v.minor === minor;
    return (v) => v.major === major && v.minor === minor;
  }

  const exact = parse(s);
  if (exact) return (v) => compare(stringify(v), stringify(exact)) === 0;
  return () => false;
}

function buildRangeMatcher(range: string): Comparator {
  const orSets = range.split("||").map((s) => s.trim());
  const orComparators = orSets.map((andSet) => {
    const tokens = andSet.trim().split(/\s+/);
    const parts: string[] = [];
    let i = 0;
    while (i < tokens.length) {
      if (i + 2 < tokens.length && tokens[i + 1] === "-") {
        parts.push(`${tokens[i]} - ${tokens[i + 2]}`);
        i += 3;
      } else {
        parts.push(tokens[i]);
        i++;
      }
    }
    const comparators = parts.map(parseComparator);
    return (v: SemVer) => comparators.every((c) => c(v));
  });
  return (v: SemVer) => orComparators.some((c) => c(v));
}

export function satisfies(version: string, range: string): boolean {
  return buildRangeMatcher(range)(parseStrict(version));
}

export function filter(versions: string[], range: string): string[] {
  const matcher = buildRangeMatcher(range);
  return versions.filter((v) => { const p = parse(v); return p !== null && matcher(p); });
}

export function sortAsc(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const av = parse(a);
    const bv = parse(b);
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return compare(stringify(av), stringify(bv));
  });
}

export function sortDesc(versions: string[]): string[] {
  return sortAsc(versions).reverse();
}

export function maxVersion(versions: string[]): string | null {
  const s = sortDesc(versions.filter(valid));
  return s.length > 0 ? s[0] : null;
}

export function minVersion(versions: string[]): string | null {
  const s = sortAsc(versions.filter(valid));
  return s.length > 0 ? s[0] : null;
}

export function bump(version: string, type: ReleaseType, identifier?: string): string {
  const v = parseStrict(version);
  const id = identifier ?? "";
  const pre = (n: number): string[] => id ? [id, String(n)] : [String(n)];
  let result: SemVer;
  switch (type) {
    case "major":     result = { ...v, major: v.major + 1, minor: 0, patch: 0, prerelease: [], buildmetadata: [] }; break;
    case "minor":     result = { ...v, minor: v.minor + 1, patch: 0, prerelease: [], buildmetadata: [] }; break;
    case "patch":     result = { ...v, patch: v.patch + 1, prerelease: [], buildmetadata: [] }; break;
    case "premajor":  result = { ...v, major: v.major + 1, minor: 0, patch: 0, prerelease: pre(0), buildmetadata: [] }; break;
    case "preminor":  result = { ...v, minor: v.minor + 1, patch: 0, prerelease: pre(0), buildmetadata: [] }; break;
    case "prepatch":  result = { ...v, patch: v.patch + 1, prerelease: pre(0), buildmetadata: [] }; break;
    case "prerelease": {
      if (v.prerelease.length === 0) {
        result = { ...v, patch: v.patch + 1, prerelease: pre(0), buildmetadata: [] };
      } else {
        const np = [...v.prerelease];
        let bumped = false;
        for (let i = np.length - 1; i >= 0; i--) {
          if (/^\d+$/.test(np[i])) { np[i] = String(parseInt(np[i], 10) + 1); bumped = true; break; }
        }
        if (!bumped) np.push("0");
        result = { ...v, prerelease: np, buildmetadata: [] };
      }
      break;
    }
    default: throw new Error(`Unknown release type: "${type}"`);
  }
  result.raw = stringify(result);
  return stringify(result);
}

export function diff(a: string, b: string): ReleaseType | "none" {
  const av = parseStrict(a);
  const bv = parseStrict(b);
  const cmp = compare(stringify(av), stringify(bv));
  if (cmp === 0) return "none";
  const [lo, hi] = cmp < 0 ? [av, bv] : [bv, av];
  if (hi.prerelease.length > 0) {
    if (hi.major !== lo.major) return "premajor";
    if (hi.minor !== lo.minor) return "preminor";
    if (hi.patch !== lo.patch) return "prepatch";
    return "prerelease";
  }
  if (hi.major !== lo.major) return "major";
  if (hi.minor !== lo.minor) return "minor";
  return "patch";
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const help = "Usage: bun packages/tools/semver.ts <parse|valid|compare|gt|lt|gte|lte|eq|satisfies|bump|diff|sort|max|min> [args...]";
  switch (cmd) {
    case "parse": console.log(parse(args[0]) ? JSON.stringify(parse(args[0]), null, 2) : "invalid"); break;
    case "valid": console.log(valid(args[0])); break;
    case "compare": console.log(compare(args[0], args[1])); break;
    case "gt": console.log(gt(args[0], args[1])); break;
    case "lt": console.log(lt(args[0], args[1])); break;
    case "gte": console.log(gte(args[0], args[1])); break;
    case "lte": console.log(lte(args[0], args[1])); break;
    case "eq": console.log(eq(args[0], args[1])); break;
    case "satisfies": console.log(satisfies(args[0], args.slice(1).join(" "))); break;
    case "bump": console.log(bump(args[0], args[1] as ReleaseType, args[2])); break;
    case "diff": console.log(diff(args[0], args[1])); break;
    case "sort": sortAsc(args).forEach((v) => console.log(v)); break;
    case "max": console.log(maxVersion(args) ?? "none"); break;
    case "min": console.log(minVersion(args) ?? "none"); break;
    default: console.log(help);
  }
}
