/**
 * IP address parser - parses and validates IPv4/IPv6 with CIDR subnet support.
 * Supports: parse, validate, CIDR matching, classification, format conversion.
 */

export type IPVersion = "v4" | "v6";
export type IPClass = "private" | "public" | "loopback" | "link-local" | "multicast" | "unspecified";

export interface ParsedIP {
  address: string;
  version: IPVersion;
  numeric: bigint;
  expanded: string;
}

// --- IPv4 helpers ---

function parseIPv4(str: string): ParsedIP | null {
  const parts = str.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some(n => isNaN(n) || n < 0 || n > 255 || String(n) !== parts[nums.indexOf(n)])) return null;
  const numeric = BigInt(nums.reduce((acc, n) => (acc * 256 + n), 0));
  return { address: str, version: "v4", numeric, expanded: str };
}

function ipv4ToNumeric(str: string): bigint | null {
  const p = parseIPv4(str);
  return p ? p.numeric : null;
}

function numericToIPv4(n: bigint): string {
  return [
    (n >> 24n) & 0xffn,
    (n >> 16n) & 0xffn,
    (n >> 8n) & 0xffn,
    n & 0xffn,
  ].map(String).join(".");
}

// --- IPv6 helpers ---

function expandIPv6(str: string): string | null {
  // Handle ::
  let groups: string[];
  if (str.includes("::")) {
    const sides = str.split("::");
    if (sides.length !== 2) return null;
    const left = sides[0] ? sides[0].split(":") : [];
    const right = sides[1] ? sides[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = str.split(":");
  }
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }
  return groups.map(g => g.padStart(4, "0")).join(":");
}

function parseIPv6(str: string): ParsedIP | null {
  const expanded = expandIPv6(str);
  if (!expanded) return null;
  const hex = expanded.replace(/:/g, "");
  const numeric = BigInt("0x" + hex);
  return { address: str, version: "v6", numeric, expanded };
}

function numericToIPv6(n: bigint): string {
  const hex = n.toString(16).padStart(32, "0");
  return hex.match(/.{4}/g)!.join(":");
}

// --- Public API ---

/**
 * Parse an IPv4 or IPv6 address string. Returns null if invalid.
 */
export function parseIP(str: string): ParsedIP | null {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  if (trimmed.includes(":")) return parseIPv6(trimmed);
  return parseIPv4(trimmed);
}

/**
 * Check whether an IP address falls within a CIDR range.
 * Supports IPv4 (e.g. "10.0.0.1", "10.0.0.0/8") and IPv6.
 */
export function isInSubnet(ip: string, cidr: string): boolean {
  const parsed = parseIP(ip);
  if (!parsed) return false;

  const slashIdx = cidr.lastIndexOf("/");
  if (slashIdx === -1) {
    // Treat bare address as /32 (v4) or /128 (v6)
    const parsedCidr = parseIP(cidr);
    return parsedCidr ? parsed.numeric === parsedCidr.numeric : false;
  }

  const netAddr = cidr.slice(0, slashIdx);
  const prefixLen = parseInt(cidr.slice(slashIdx + 1), 10);
  const parsedNet = parseIP(netAddr);

  if (!parsedNet || parsedNet.version !== parsed.version) return false;

  const maxBits = parsed.version === "v4" ? 32 : 128;
  if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > maxBits) return false;

  if (prefixLen === 0) return true;

  const shift = BigInt(maxBits - prefixLen);
  return (parsed.numeric >> shift) === (parsedNet.numeric >> shift);
}

/**
 * Classify an IP address as private, public, loopback, link-local, multicast, or unspecified.
 */
export function classifyIP(ip: string): IPClass | null {
  const parsed = parseIP(ip);
  if (!parsed) return null;

  if (parsed.version === "v4") {
    const n = parsed.numeric;
    if (n === 0n) return "unspecified";                          // 0.0.0.0
    if ((n >> 24n) === 127n) return "loopback";                  // 127.x.x.x
    if ((n >> 24n) === 10n) return "private";                    // 10.0.0.0/8
    if ((n >> 20n) === 0xac1n) return "private";                 // 172.16.0.0/12
    if ((n >> 16n) === 0xc0a8n) return "private";                // 192.168.0.0/16
    if ((n >> 16n) === 0xa9fen) return "link-local";             // 169.254.0.0/16
    if ((n >> 28n) === 0xen) return "multicast";                 // 224.0.0.0/4
    return "public";
  }

  // IPv6
  const n = parsed.numeric;
  if (n === 0n) return "unspecified";                                        // ::
  if (n === 1n) return "loopback";                                           // ::1
  if ((n >> 112n) === 0xfe80n) return "link-local";                         // fe80::/10
  if ((n >> 120n) === 0xffn) return "multicast";                            // ff00::/8
  if ((n >> 112n) === 0xfc00n || (n >> 112n) === 0xfd00n) return "private"; // fc00::/7 ULA
  return "public";
}

/**
 * Convert an IPv4 address to its IPv4-mapped IPv6 representation (::ffff:x.x.x.x).
 * Returns null if not a valid IPv4 address.
 */
export function ipv4ToMappedIPv6(ip: string): string | null {
  const n = ipv4ToNumeric(ip);
  if (n === null) return null;
  const mapped = (0xffffn << 32n) | n;
  return "::" + numericToIPv6(mapped).slice(-9); // ::ffff:x.x.x.x short form
}

/**
 * If an IPv6 address is IPv4-mapped (::ffff:0:0/96), extract and return the IPv4 portion.
 * Returns null otherwise.
 */
export function mappedIPv6ToIPv4(ip: string): string | null {
  const parsed = parseIPv6(ip);
  if (!parsed) return null;
  const prefix = parsed.numeric >> 32n;
  if (prefix !== 0xffffn) return null;
  return numericToIPv4(parsed.numeric & 0xffffffffn);
}
