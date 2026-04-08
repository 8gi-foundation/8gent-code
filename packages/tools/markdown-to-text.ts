/**
 * markdown-to-text
 *
 * Strips markdown formatting to produce clean plain text.
 * Preserves content structure while removing all syntax.
 *
 * Handles: headers, bold, italic, strikethrough, links, images,
 * inline code, fenced code blocks, blockquotes, ordered/unordered
 * lists, tables, horizontal rules, HTML tags.
 */

export interface MdToTextOptions {
  /** Preserve newlines from block elements (default: true) */
  preserveNewlines?: boolean;
  /** Collapse multiple blank lines into one (default: true) */
  collapseBlankLines?: boolean;
  /** Trim leading/trailing whitespace from result (default: true) */
  trim?: boolean;
}

/**
 * Convert markdown string to plain text.
 *
 * @param markdown - Raw markdown input
 * @param options  - Optional processing flags
 * @returns Clean plain text with no markdown syntax
 */
export function mdToText(
  markdown: string,
  options: MdToTextOptions = {}
): string {
  const {
    preserveNewlines = true,
    collapseBlankLines = true,
    trim = true,
  } = options;

  let text = markdown;

  // --- Block-level elements (process before inline) ---

  // Fenced code blocks - keep content, strip fences
  text = text.replace(/^```[\w]*\n([\s\S]*?)```$/gm, (_, code) =>
    code.trimEnd()
  );

  // Indented code blocks (4 spaces or tab)
  text = text.replace(/^(?:    |\t)(.+)$/gm, (_, line) => line);

  // ATX headers (# Heading)
  text = text.replace(/^#{1,6}\s+(.+?)(?:\s+#+)?$/gm, (_, heading) => heading);

  // Setext headers (underline style)
  text = text.replace(/^(.+)\n[=\-]{2,}$/gm, (_, heading) => heading);

  // Horizontal rules
  text = text.replace(/^[ \t]*(?:[*\-_][ \t]*){3,}$/gm, "");

  // Blockquotes - strip leading >
  text = text.replace(/^>+\s?/gm, "");

  // Tables - extract cell content, drop separator rows
  text = text.replace(/^\|(.+)\|$/gm, (_, row) => {
    // Drop separator rows (--- cells only)
    if (/^[\s|:\-]+$/.test(row)) return "";
    return row
      .split("|")
      .map((cell: string) => cell.trim())
      .filter(Boolean)
      .join("  ");
  });

  // Unordered list markers
  text = text.replace(/^[ \t]*[-*+]\s+/gm, "");

  // Ordered list markers
  text = text.replace(/^[ \t]*\d+\.\s+/gm, "");

  // --- Inline elements ---

  // Images - keep alt text, drop src and title
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt);

  // Reference-style images
  text = text.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_, alt) => alt);

  // Links - keep link text, drop URL and title
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, (_, linkText) => linkText);

  // Reference-style links
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, (_, linkText) => linkText);

  // Auto-links
  text = text.replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url);

  // Bold + italic combined (***text*** or ___text___)
  text = text.replace(/\*{3}(.+?)\*{3}/g, (_, t) => t);
  text = text.replace(/_{3}(.+?)_{3}/g, (_, t) => t);

  // Bold (**text** or __text__)
  text = text.replace(/\*{2}(.+?)\*{2}/g, (_, t) => t);
  text = text.replace(/_{2}(.+?)_{2}/g, (_, t) => t);

  // Italic (*text* or _text_)
  text = text.replace(/\*(.+?)\*/g, (_, t) => t);
  text = text.replace(/_(.+?)_/g, (_, t) => t);

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, (_, t) => t);

  // Inline code
  text = text.replace(/`+(.+?)`+/g, (_, code) => code);

  // HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // HTML entities (common ones)
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Reference link definitions - strip entirely
  text = text.replace(/^\[.+\]:\s+.+$/gm, "");

  // --- Whitespace cleanup ---

  if (!preserveNewlines) {
    text = text.replace(/\n+/g, " ");
  } else if (collapseBlankLines) {
    // Collapse 3+ consecutive newlines into 2
    text = text.replace(/\n{3,}/g, "\n\n");
  }

  if (trim) {
    text = text.trim();
  }

  return text;
}
