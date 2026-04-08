/**
 * RFC 6570 URI Template Expansion
 *
 * Implements Level 1-4 URI template expansion for all operator types defined
 * in RFC 6570. Supports variable expansion, list/map explode, and prefix modifiers.
 *
 * Spec: https://www.rfc-editor.org/rfc/rfc6570
 */

// Characters allowed unencoded in "unreserved" set (RFC 6570 section 1.5)
const UNRESERVED_RE = /^[A-Za-z0-9\-._~]$/;

// Characters allowed unencoded in "reserved" set (RFC 6570 section 1.5)
const RESERVED_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]$/;

function pctEncode(str: string, allowReserved: boolean): string {
  return Array.from(str)
    .map((ch) => {
      if (UNRESERVED_RE.test(ch)) return ch;
      if (allowReserved && RESERVED_RE.test(ch)) return ch;
      const bytes = new TextEncoder().encode(ch);
      return Array.from(bytes)
        .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
        .join("");
    })
    .join("");
}

export interface TemplateToken {
  type: "literal" | "expression";
  value: string;
  operator?: string;
  variables?: Array<{ name: string; explode: boolean; maxLength: number }>;
}

/**
 * Parse a URI template into a sequence of literal and expression tokens.
 * Throws if the template contains unclosed braces.
 */
export function parse(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  const re = /\{([^}]*)\}|([^{]+)/g;
  let lastIndex = 0;

  for (const match of template.matchAll(re)) {
    lastIndex = match.index + match[0].length;

    if (match[2] !== undefined) {
      // Literal segment
      tokens.push({ type: "literal", value: match[2] });
    } else {
      // Expression
      const inner = match[1];
      const opMatch = inner.match(/^([+#./;?&]?)(.*)/);
      const operator = opMatch![1];
      const varList = opMatch![2];

      const variables = varList.split(",").map((v) => {
        const explode = v.endsWith("*");
        const name = explode ? v.slice(0, -1) : v;
        const colonIdx = name.indexOf(":");
        const maxLength = colonIdx >= 0 ? parseInt(name.slice(colonIdx + 1), 10) : 0;
        const finalName = colonIdx >= 0 ? name.slice(0, colonIdx) : name;
        return { name: finalName, explode, maxLength };
      });

      tokens.push({ type: "expression", value: match[0], operator, variables });
    }
  }

  if (lastIndex < template.length) {
    tokens.push({ type: "literal", value: template.slice(lastIndex) });
  }

  return tokens;
}

/**
 * Validate a URI template. Returns null if valid, or an error message string.
 */
export function validate(template: string): string | null {
  let depth = 0;
  for (let i = 0; i < template.length; i++) {
    if (template[i] === "{") {
      depth++;
      if (depth > 1) return `Nested braces at position ${i}`;
    } else if (template[i] === "}") {
      depth--;
      if (depth < 0) return `Unmatched closing brace at position ${i}`;
    }
  }
  if (depth !== 0) return "Unclosed brace in template";

  // Check each expression has valid operator and variable names
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    const inner = match[1];
    if (inner.trim() === "") return `Empty expression: ${match[0]}`;
    const opMatch = inner.match(/^([+#./;?&]?)(.*)/);
    const vars = opMatch![2];
    for (const v of vars.split(",")) {
      const name = v.replace(/\*$/, "").replace(/:\d+$/, "");
      if (!/^[A-Za-z0-9_%][A-Za-z0-9_%.]*$/.test(name)) {
        return `Invalid variable name: "${name}"`;
      }
    }
  }

  return null;
}

type VarValue = string | number | string[] | Record<string, string> | undefined | null;

const OPERATOR_CONFIG: Record<string, { prefix: string; separator: string; named: boolean; allowReserved: boolean; empty: string }> = {
  "":  { prefix: "",  separator: ",", named: false, allowReserved: false, empty: "" },
  "+": { prefix: "",  separator: ",", named: false, allowReserved: true,  empty: "" },
  "#": { prefix: "#", separator: ",", named: false, allowReserved: true,  empty: "" },
  ".": { prefix: ".", separator: ".", named: false, allowReserved: false, empty: "" },
  "/": { prefix: "/", separator: "/", named: false, allowReserved: false, empty: "" },
  ";": { prefix: ";", separator: ";", named: true,  allowReserved: false, empty: "" },
  "?": { prefix: "?", separator: "&", named: true,  allowReserved: false, empty: "=" },
  "&": { prefix: "&", separator: "&", named: true,  allowReserved: false, empty: "=" },
};

function expandVariable(
  name: string,
  value: VarValue,
  explode: boolean,
  maxLength: number,
  cfg: (typeof OPERATOR_CONFIG)[string]
): string | null {
  if (value === undefined || value === null) return null;

  const encode = (s: string) => pctEncode(String(s), cfg.allowReserved);

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (explode) {
      return value.map((v) => (cfg.named ? `${name}=${encode(v)}` : encode(v))).join(cfg.separator);
    }
    return (cfg.named ? `${name}=` : "") + value.map(encode).join(",");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    if (explode) {
      return entries.map(([k, v]) => `${encode(k)}=${encode(v)}`).join(cfg.separator);
    }
    return (cfg.named ? `${name}=` : "") + entries.map(([k, v]) => `${encode(k)},${encode(v)}`).join(",");
  }

  let str = String(value);
  if (maxLength > 0) str = str.slice(0, maxLength);
  const encoded = encode(str);

  if (cfg.named) {
    return encoded === "" ? `${name}${cfg.empty}` : `${name}=${encoded}`;
  }
  return encoded;
}

/**
 * Expand a URI template against a variables map.
 * Unknown variables are treated as undefined (omitted from output).
 */
export function expand(template: string, vars: Record<string, VarValue> = {}): string {
  const tokens = parse(template);
  return tokens
    .map((token) => {
      if (token.type === "literal") return token.value;

      const cfg = OPERATOR_CONFIG[token.operator ?? ""];
      if (!cfg) return token.value;

      const parts: string[] = [];
      for (const { name, explode, maxLength } of token.variables ?? []) {
        const expanded = expandVariable(name, vars[name], explode, maxLength, cfg);
        if (expanded !== null) parts.push(expanded);
      }

      return parts.length === 0 ? "" : cfg.prefix + parts.join(cfg.separator);
    })
    .join("");
}
