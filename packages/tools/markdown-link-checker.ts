import { existsSync } from "fs";
import { resolve, dirname, join } from "path";

export type LinkKind = "http" | "relative" | "anchor";

export interface Link {
  text: string;
  href: string;
  kind: LinkKind;
  line: number;
}

export interface LinkCheckResult {
  link: Link;
  ok: boolean;
  reason?: string;
}

// Classify a raw href string
function classify(href: string): LinkKind {
  if (href.startsWith("#")) return "anchor";
  if (/^https?:\/\//i.test(href)) return "http";
  return "relative";
}

/**
 * Extract all links from a markdown string.
 * Handles: inline [text](url), reference [text][id], autolinks <http://...>
 */
export function extractLinks(md: string): Link[] {
  const links: Link[] = [];
  const lines = md.split("\n");

  // Build reference map: [id]: url
  const refMap: Record<string, string> = {};
  const refDef = /^\s{0,3}\[([^\]]+)\]:\s+(\S+)/;
  for (const line of lines) {
    const m = refDef.exec(line);
    if (m) refMap[m[1].toLowerCase()] = m[2];
  }

  // Inline links: [text](href) or [text](href "title")
  const inlineRe = /\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
  // Reference links: [text][id] or [text][]
  const refRe = /\[([^\]]+)\]\[([^\]]*)\]/g;
  // Autolinks: <http://...>
  const autoRe = /<(https?:\/\/[^>]+)>/g;
  // Bare shortcut reference: [text] where text matches a ref id
  const shortcutRe = /\[([^\]]+)\](?!\[|\()/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip ref definition lines
    if (refDef.test(line)) continue;

    let m: RegExpExecArray | null;

    inlineRe.lastIndex = 0;
    while ((m = inlineRe.exec(line)) !== null) {
      links.push({ text: m[1], href: m[2], kind: classify(m[2]), line: lineNum });
    }

    refRe.lastIndex = 0;
    while ((m = refRe.exec(line)) !== null) {
      const id = (m[2] || m[1]).toLowerCase();
      const href = refMap[id];
      if (href) {
        links.push({ text: m[1], href, kind: classify(href), line: lineNum });
      }
    }

    autoRe.lastIndex = 0;
    while ((m = autoRe.exec(line)) !== null) {
      links.push({ text: m[1], href: m[1], kind: "http", line: lineNum });
    }

    shortcutRe.lastIndex = 0;
    while ((m = shortcutRe.exec(line)) !== null) {
      const id = m[1].toLowerCase();
      const href = refMap[id];
      if (href) {
        links.push({ text: m[1], href, kind: classify(href), line: lineNum });
      }
    }
  }

  return links;
}

/**
 * Check all links extracted from markdown.
 * - http: not fetched (flagged as unchecked)
 * - relative: resolved against basePath, checked for existence
 * - anchor: verified against headings in the same document
 *
 * @param md       Markdown source string
 * @param basePath Absolute directory path to resolve relative links from
 */
export function checkLinks(md: string, basePath: string): LinkCheckResult[] {
  const links = extractLinks(md);
  const results: LinkCheckResult[] = [];

  // Build anchor set from ATX headings
  const anchorSet = new Set<string>();
  for (const line of md.split("\n")) {
    const hm = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (hm) {
      // GitHub-style slug: lowercase, spaces -> hyphens, strip non-alphanumeric except hyphens
      const slug = hm[1]
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-");
      anchorSet.add("#" + slug);
    }
  }

  for (const link of links) {
    if (link.kind === "http") {
      results.push({ link, ok: true, reason: "http - not fetched" });
    } else if (link.kind === "anchor") {
      const ok = anchorSet.has(link.href);
      results.push({ link, ok, reason: ok ? undefined : `anchor '${link.href}' not found in document` });
    } else {
      // relative - strip anchor fragment before checking file existence
      const [filePart] = link.href.split("#");
      if (!filePart) {
        // href is just a fragment - treat as anchor
        const ok = anchorSet.has(link.href);
        results.push({ link, ok, reason: ok ? undefined : `anchor '${link.href}' not found in document` });
      } else {
        const abs = resolve(join(basePath, filePart));
        const ok = existsSync(abs);
        results.push({ link, ok, reason: ok ? undefined : `file not found: ${abs}` });
      }
    }
  }

  return results;
}

/** Return only broken links */
export function brokenLinks(md: string, basePath: string): LinkCheckResult[] {
  return checkLinks(md, basePath).filter((r) => !r.ok);
}
