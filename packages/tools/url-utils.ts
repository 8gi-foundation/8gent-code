/**
 * url-utils.ts
 * URL parsing, building, validation, and manipulation utilities.
 * Zero dependencies. All functions are pure.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedUrl {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
  host: string;
  origin: string;
  href: string;
}

export interface UrlComponents {
  protocol?: string;
  username?: string;
  password?: string;
  hostname: string;
  port?: string | number;
  pathname?: string;
  query?: Record<string, string | string[] | undefined>;
  hash?: string;
}

export interface DomainInfo {
  subdomain: string;
  domain: string;
  tld: string;
  registrable: string;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Parse a URL string into its components. Returns null if invalid. */
export function parseUrl(raw: string): ParsedUrl | null {
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol.replace(/:$/, ""),
      username: u.username,
      password: u.password,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash.replace(/^#/, ""),
      host: u.host,
      origin: u.origin,
      href: u.href,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Build a URL string from components. Throws if result is invalid. */
export function buildUrl(components: UrlComponents): string {
  const {
    protocol = "https",
    username = "",
    password = "",
    hostname,
    port,
    pathname = "/",
    query,
    hash = "",
  } = components;

  const proto = protocol.replace(/:$/, "");
  const portStr = port !== undefined && port !== "" ? `:${port}` : "";
  const auth = username
    ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const qs = query ? buildQueryString(query) : "";
  const searchPart = qs ? `?${qs}` : "";
  const hashPart = hash ? `#${hash.replace(/^#/, "")}` : "";
  const href = `${proto}://${auth}${hostname}${portStr}${path}${searchPart}${hashPart}`;
  const u = new URL(href);
  return u.href;
}

// ---------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------

/**
 * Parse a query string (with or without leading ?) into a key-value record.
 * Keys that appear multiple times are returned as arrays.
 */
export function parseQueryString(qs: string): Record<string, string | string[]> {
  const cleaned = qs.startsWith("?") ? qs.slice(1) : qs;
  if (!cleaned) return {};
  const result: Record<string, string | string[]> = {};
  for (const part of cleaned.split("&")) {
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    const key = decodeURIComponent(eqIdx === -1 ? part : part.slice(0, eqIdx));
    const val = eqIdx === -1 ? "" : decodeURIComponent(part.slice(eqIdx + 1));
    if (key in result) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, val] : [existing, val];
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Build a query string from a record.
 * Arrays expand to repeated key=value pairs. Undefined values are omitted.
 * Does NOT include the leading ?.
 */
export function buildQueryString(
  params: Record<string, string | string[] | undefined>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const k = encodeURIComponent(key);
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${k}=${encodeURIComponent(v)}`);
    } else {
      parts.push(`${k}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

/**
 * Merge query params into an existing URL.
 * Existing keys are overwritten; undefined values remove a key.
 */
export function mergeQueryParams(
  url: string,
  params: Record<string, string | string[] | undefined>
): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`Invalid URL: ${url}`);
  const existing = parseQueryString(parsed.search) as Record<string, string | string[] | undefined>;
  const merged = { ...existing, ...params };
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  const qs = buildQueryString(merged as Record<string, string | string[]>);
  const base = `${parsed.origin}${parsed.pathname}`;
  const hashPart = parsed.hash ? `#${parsed.hash}` : "";
  return qs ? `${base}?${qs}${hashPart}` : `${base}${hashPart}`;
}

// ---------------------------------------------------------------------------
// Path joining
// ---------------------------------------------------------------------------

function resolveDotSegments(path: string): string {
  const leading = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  const result = out.join("/");
  return leading && !result.startsWith("/") ? `/${result}` : result;
}

/**
 * Join URL path segments, collapsing double slashes and resolving . and ..
 * First segment may be a full URL - the origin is preserved.
 */
export function joinPaths(...segments: string[]): string {
  if (segments.length === 0) return "";
  const firstIsUrl = /^https?:\/\//i.test(segments[0]);
  let base = "";
  let pathParts: string[];
  if (firstIsUrl) {
    const parsed = parseUrl(segments[0]);
    if (!parsed) throw new Error(`Invalid base URL: ${segments[0]}`);
    base = parsed.origin;
    pathParts = [parsed.pathname, ...segments.slice(1)];
  } else {
    pathParts = segments;
  }
  const joined = pathParts
    .map((s, i) => (i === 0 ? s : s.replace(/^\/+/, "")))
    .join("/")
    .replace(/\/+/g, "/");
  const resolved = resolveDotSegments(joined);
  return base ? `${base}${resolved}` : resolved;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Return true if the string is a valid absolute URL. */
export function isValidUrl(url: string): boolean {
  return parseUrl(url) !== null;
}

/** Return true if the URL protocol is http or https. */
export function isHttpUrl(url: string): boolean {
  const p = parseUrl(url);
  return p !== null && (p.protocol === "http" || p.protocol === "https");
}

/** Return true if the URL protocol is https. */
export function isSecureUrl(url: string): boolean {
  const p = parseUrl(url);
  return p !== null && p.protocol === "https";
}

// ---------------------------------------------------------------------------
// Domain / TLD extraction
// ---------------------------------------------------------------------------

/**
 * Extract domain info from a hostname or full URL.
 * Handles common two-part TLDs (co.uk, com.au, etc.).
 */
export function extractDomain(urlOrHostname: string): DomainInfo | null {
  let hostname = urlOrHostname;
  if (/^https?:\/\//i.test(urlOrHostname)) {
    const parsed = parseUrl(urlOrHostname);
    if (!parsed) return null;
    hostname = parsed.hostname;
  }
  hostname = hostname.split(":")[0].toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  if (labels.length < 2) return null;

  const twoPartTlds = new Set([
    "co.uk", "co.nz", "co.za", "co.jp", "co.in", "co.id", "co.kr",
    "com.au", "com.br", "com.mx", "com.ar", "com.sg", "com.hk",
    "org.uk", "net.au", "gov.uk", "gov.au", "ac.uk", "ac.nz",
  ]);

  const lastTwo = labels.slice(-2).join(".");
  const isMultiPart = twoPartTlds.has(lastTwo);

  let tld, domain, subdomain;

  if (isMultiPart && labels.length >= 3) {
    tld = labels.slice(-2).join(".");
    domain = labels[labels.length - 3];
    subdomain = labels.slice(0, labels.length - 3).join(".");
  } else {
    tld = labels[labels.length - 1];
    domain = labels[labels.length - 2];
    subdomain = labels.slice(0, labels.length - 2).join(".");
  }

  return { subdomain, domain, tld, registrable: `${domain}.${tld}` };
}

/** Return just the TLD portion of a hostname or URL. Empty string if not determinable. */
export function extractTld(urlOrHostname: string): string {
  const info = extractDomain(urlOrHostname);
  return info ? info.tld : "";
}

/** Return the registrable domain (domain + TLD) without subdomain. */
export function extractRegistrableDomain(urlOrHostname: string): string {
  const info = extractDomain(urlOrHostname);
  return info ? info.registrable : "";
}

// ---------------------------------------------------------------------------
// Local URL detection
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const LOCAL_IP_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

/**
 * Return true if the URL points to a local or private network address.
 * Covers localhost, 127.x, RFC-1918, link-local IPv4/IPv6, and .local TLD.
 */
export function isLocalUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(hostname)) return true;
  if (hostname.endsWith(".local")) return true;
  for (const p of LOCAL_IP_PATTERNS) {
    if (p.test(hostname)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Ensure the URL pathname ends with /. */
export function addTrailingSlash(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`Invalid URL: ${url}`);
  if (parsed.pathname.endsWith("/")) return url;
  return url.replace(parsed.pathname, `${parsed.pathname}/`);
}

/** Strip trailing / from the pathname (preserves root /). */
export function removeTrailingSlash(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`Invalid URL: ${url}`);
  if (parsed.pathname === "/" || !parsed.pathname.endsWith("/")) return url;
  return url.replace(parsed.pathname, parsed.pathname.replace(/\/$/, ""));
}

/** Return the URL without its query string and hash. */
export function stripQueryAndHash(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`Invalid URL: ${url}`);
  return `${parsed.origin}${parsed.pathname}`;
}

/** Return the URL without its hash fragment. */
export function stripHash(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`Invalid URL: ${url}`);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}
