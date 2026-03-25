/**
 * Layout Feedback - Static layout analysis for agent-generated UI code.
 * Inspired by Agentation's structured feedback approach.
 * Analyzes HTML/JSX and produces actionable design feedback for Eight.
 */
export type Severity = "error" | "warning" | "info";
export type Category = "spacing" | "hierarchy" | "structure" | "accessibility";

export interface LayoutIssue {
  severity: Severity;
  category: Category;
  element: string;
  line: number;
  message: string;
  suggestion: string;
}

export interface LayoutReport {
  issues: LayoutIssue[];
  score: number;
  summary: string;
}

interface ParsedElement {
  tag: string;
  attrs: Record<string, string>;
  line: number;
  raw: string;
}

function issue(s: Severity, c: Category, el: string, ln: number, msg: string, sug: string): LayoutIssue {
  return { severity: s, category: c, element: el, line: ln, message: msg, suggestion: sug };
}

function parseElements(source: string): ParsedElement[] {
  const elements: ParsedElement[] = [];
  const lines = source.split("\n");
  const tagRe = /<(\w[\w-]*)((?:\s+[\w-]+(?:=(?:"[^"]*"|'[^']*'|\{[^}]*\}))?)*)\s*\/?>/g;
  for (let i = 0; i < lines.length; i++) {
    tagRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(lines[i])) !== null) {
      const attrs: Record<string, string> = {};
      const aRe = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
      let a: RegExpExecArray | null;
      while ((a = aRe.exec(m[2])) !== null) attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? "";
      elements.push({ tag: m[1], attrs, line: i + 1, raw: m[0] });
    }
  }
  return elements;
}

function checkSpacing(els: ParsedElement[]): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const spacingProps = ["margin", "padding", "gap", "marginTop", "marginBottom", "paddingTop", "paddingBottom"];
  const units = new Set<string>();
  for (const el of els) {
    const style = el.attrs.style ?? el.attrs.className ?? "";
    for (const u of style.match(/\d+(px|rem|em|%|vh|vw)/g) ?? []) units.add(u.replace(/[\d.]+/, ""));
    for (const p of spacingProps) {
      if (el.attrs[p]?.match(/^\d+$/))
        out.push(issue("warning", "spacing", el.tag, el.line,
          `Raw number for ${p} - missing unit`, `Use a spacing token or explicit unit`));
    }
  }
  if (units.size > 2)
    out.push(issue("warning", "spacing", "(global)", 1,
      `Mixed spacing units: ${[...units].join(", ")}`, "Standardize on one unit system (rem preferred)"));
  return out;
}

function checkHierarchy(els: ParsedElement[]): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const headings = els.filter((el) => /^h[1-6]$/.test(el.tag));
  let last = 0;
  for (const h of headings) {
    const lvl = parseInt(h.tag[1], 10);
    if (last > 0 && lvl > last + 1)
      out.push(issue("error", "hierarchy", h.tag, h.line,
        `Heading level skipped: h${last} to h${lvl}`, `Use h${last + 1} instead`));
    last = lvl;
  }
  const h1s = headings.filter((h) => h.tag === "h1");
  if (h1s.length > 1)
    out.push(issue("warning", "hierarchy", "h1", h1s[1].line,
      `Multiple h1 elements (${h1s.length})`, "Use a single h1 per page"));
  return out;
}

function checkStructure(els: ParsedElement[]): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const wrappers = new Set(["div", "Box", "View", "span"]);
  let run = 0, start = 0;
  for (const el of els) {
    if (wrappers.has(el.tag)) {
      if (run === 0) start = el.line;
      run++;
      if (run >= 4) {
        out.push(issue("warning", "structure", el.tag, start,
          `${run} nested wrappers without semantic tags`,
          "Use section, article, nav, aside, or main instead"));
        run = 0;
      }
    } else run = 0;
  }
  return out;
}

function checkAccessibility(els: ParsedElement[]): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  for (const el of els) {
    if (el.tag === "img" && !("alt" in el.attrs))
      out.push(issue("error", "accessibility", "img", el.line,
        "Image missing alt attribute", 'Add alt="description" or alt="" for decorative'));
    if ((el.tag === "button" || el.tag === "a") && !el.attrs["aria-label"] && el.raw.includes("/>"))
      out.push(issue("warning", "accessibility", el.tag, el.line,
        `Self-closing ${el.tag} may lack accessible text`, "Add aria-label or visible text"));
  }
  const landmarks = els.filter((el) => ["main", "nav", "header", "footer", "aside"].includes(el.tag));
  if (els.length > 20 && landmarks.length === 0)
    out.push(issue("info", "accessibility", "(global)", 1,
      "No landmark elements in a sizable document", "Add main, nav, header, footer for screen readers"));
  return out;
}

/** Analyze HTML/JSX source for layout and design issues. */
export function analyzeLayout(source: string): LayoutReport {
  const els = parseElements(source);
  const issues = [
    ...checkSpacing(els), ...checkHierarchy(els),
    ...checkStructure(els), ...checkAccessibility(els),
  ];
  const ded = { error: 15, warning: 5, info: 1 };
  const score = Math.max(0, issues.reduce((s, i) => s - ded[i.severity], 100));
  const errs = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warning").length;
  const summary = issues.length === 0
    ? "No layout issues detected."
    : `Found ${issues.length} issues (${errs} errors, ${warns} warnings). Score: ${score}/100.`;
  return { issues, score, summary };
}
