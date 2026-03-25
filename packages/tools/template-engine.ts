/**
 * template-engine.ts - Mustache-style template engine for code, docs, and messages.
 *
 * Supports:
 *   {{variable}}           - plain substitution
 *   {{#section}}...{{/section}} - conditional/truthy blocks
 *   {{^section}}...{{/section}} - inverted (falsy) blocks
 *   {{#list}}...{{/list}}       - array iteration (item exposed as {{.}})
 *   {{! comment }}          - comments (stripped)
 *
 * No dependencies. ~100 lines.
 */

export type TemplateData = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Core render
// ---------------------------------------------------------------------------

export function render(template: string, data: TemplateData): string {
  let out = template;

  // 1. Strip comments
  out = out.replace(/\{\{![\s\S]*?\}\}/g, "");

  // 2. Sections (conditional + iteration) - process innermost first
  out = processSections(out, data);

  // 3. Variable substitution
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const val = resolve(data, key);
    return val == null ? "" : String(val);
  });

  return out;
}

// ---------------------------------------------------------------------------
// Section processing
// ---------------------------------------------------------------------------

const SECTION_RE =
  /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

const INVERTED_RE =
  /\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;

function processSections(template: string, data: TemplateData): string {
  let out = template;
  let prev = "";

  // Loop until stable (handles nested sections)
  while (out !== prev) {
    prev = out;

    // Inverted sections - render body when value is falsy/empty
    out = out.replace(INVERTED_RE, (_match, key: string, body: string) => {
      const val = resolve(data, key);
      const empty =
        val == null ||
        val === false ||
        val === "" ||
        (Array.isArray(val) && val.length === 0);
      return empty ? body : "";
    });

    // Normal sections - conditional or array iteration
    out = out.replace(SECTION_RE, (_match, key: string, body: string) => {
      const val = resolve(data, key);

      if (Array.isArray(val)) {
        return val
          .map((item) => {
            if (typeof item === "object" && item !== null) {
              return render(body, item as TemplateData);
            }
            return body.replace(/\{\{\s*\.\s*\}\}/g, String(item));
          })
          .join("");
      }

      if (val && val !== "") {
        if (typeof val === "object") {
          return render(body, val as TemplateData);
        }
        return render(body, data);
      }

      return "";
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Dot-path resolver
// ---------------------------------------------------------------------------

function resolve(data: TemplateData, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[part];
  }, data);
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Render a template from a file path (Bun-native). */
export async function renderFile(
  filePath: string,
  data: TemplateData,
): Promise<string> {
  const tpl = await Bun.file(filePath).text();
  return render(tpl, data);
}

/** List all {{variable}} placeholders found in a template string. */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  const cleaned = template
    .replace(/\{\{![\s\S]*?\}\}/g, "")
    .replace(/\{\{[#/^](\w+)\}\}/g, "");
  for (const m of cleaned.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (m[1] !== ".") vars.add(m[1]);
  }
  return [...vars];
}
