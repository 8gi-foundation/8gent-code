/**
 * 8gent Browser - HTML to Text
 *
 * Zero-dep HTML stripping. Removes noise, returns readable text.
 * Max 50KB output to avoid blowing context.
 */

const MAX_BYTES = 50_000;

// Tags whose entire subtree (content included) should be dropped
const BLOCK_TAGS = ["script", "style", "nav", "header", "footer", "aside", "noscript", "svg", "form", "iframe"];

/**
 * Strip HTML and return readable plain text with extracted title + links.
 */
export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  // --- title ---
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";

  // --- remove blocked subtrees ---
  let cleaned = html;
  for (const tag of BLOCK_TAGS) {
    // non-greedy removal of full tag block
    cleaned = cleaned.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    // self-closing variant
    cleaned = cleaned.replace(new RegExp(`<${tag}[^>]*\\/>`, "gi"), " ");
  }

  // --- extract links before stripping ---
  const links: string[] = [];
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRe.exec(cleaned)) !== null) {
    const href = linkMatch[1].trim();
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      links.push(href);
    }
  }

  // --- strip remaining tags ---
  let text = cleaned.replace(/<[^>]+>/g, " ");

  // --- decode entities ---
  text = decodeEntities(text);

  // --- collapse whitespace ---
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  // --- truncate ---
  if (text.length > MAX_BYTES) {
    text = text.slice(0, MAX_BYTES) + "\n\n[content truncated]";
  }

  return { title, text, links: dedupeLinks(links) };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, " ");
}

function dedupeLinks(links: string[]): string[] {
  return [...new Set(links)].slice(0, 100);
}
