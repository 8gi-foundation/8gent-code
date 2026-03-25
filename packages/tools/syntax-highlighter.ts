/**
 * ANSI syntax highlighter for terminal code display.
 * Tokenizes TS/JS/Python/JSON and applies ANSI escape codes per token type.
 */

// ANSI escape helpers
const RESET = "\x1b[0m";
const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}${RESET}`;

const colors = {
  keyword: ansi(34),    // blue
  string: ansi(32),     // green
  number: ansi(33),     // yellow
  comment: ansi(2),     // dim
  operator: ansi(36),   // cyan
  identifier: ansi(0),  // default fg
  punctuation: ansi(0), // default fg
  builtin: ansi(35),    // magenta
};

type TokenType = keyof typeof colors;

interface Token {
  type: TokenType;
  value: string;
}

const JS_TS_KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false",
  "finally", "for", "function", "if", "import", "in", "instanceof",
  "let", "new", "null", "return", "static", "super", "switch", "this",
  "throw", "true", "try", "typeof", "undefined", "var", "void", "while",
  "with", "yield", "async", "await", "of", "from", "as", "type",
  "interface", "enum", "namespace", "abstract", "declare", "readonly",
  "implements", "override",
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "False", "finally", "for",
  "from", "global", "if", "import", "in", "is", "lambda", "None",
  "nonlocal", "not", "or", "pass", "raise", "return", "True", "try",
  "while", "with", "yield",
]);

const JS_BUILTINS = new Set([
  "console", "Math", "Object", "Array", "String", "Number", "Boolean",
  "Promise", "Error", "JSON", "Date", "RegExp", "Map", "Set",
  "parseInt", "parseFloat", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "fetch", "process", "require", "module", "exports",
]);

function tokenizeJsTsJson(code: string, isJson: boolean): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    if (!isJson && code[i] === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const val = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: "comment", value: val });
      i += val.length;
      continue;
    }

    if (!isJson && code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const val = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ type: "comment", value: val });
      i += val.length;
      continue;
    }

    if (code[i] === '"' || code[i] === "'" || (!isJson && code[i] === "`")) {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\" && quote !== "`") { j += 2; continue; }
        if (code[j] === quote) { j++; break; }
        j++;
      }
      tokens.push({ type: "string", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (/[0-9]/.test(code[i]) || (code[i] === "-" && /[0-9]/.test(code[i + 1] || ""))) {
      let j = i;
      if (code[j] === "-") j++;
      while (j < code.length && /[0-9._xXa-fA-FbBoO]/.test(code[j])) j++;
      tokens.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const isKw = JS_TS_KEYWORDS.has(word);
      const isBuiltin = !isJson && JS_BUILTINS.has(word);
      tokens.push({ type: isKw ? "keyword" : isBuiltin ? "builtin" : "identifier", value: word });
      i = j;
      continue;
    }

    if (/[+\-*/%=!<>&|^~?:]/.test(code[i])) {
      tokens.push({ type: "operator", value: code[i] });
      i++;
      continue;
    }

    tokens.push({ type: "punctuation", value: code[i] });
    i++;
  }

  return tokens;
}

function tokenizePython(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    if (code[i] === "#") {
      const end = code.indexOf("\n", i);
      const val = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ type: "comment", value: val });
      i += val.length;
      continue;
    }

    if ((code[i] === '"' || code[i] === "'") && code.slice(i, i + 3) === code[i].repeat(3)) {
      const q = code[i].repeat(3);
      const end = code.indexOf(q, i + 3);
      const val = end === -1 ? code.slice(i) : code.slice(i, end + 3);
      tokens.push({ type: "string", value: val });
      i += val.length;
      continue;
    }

    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== quote && code[j] !== "\n") {
        if (code[j] === "\\") j++;
        j++;
      }
      tokens.push({ type: "string", value: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[0-9._xXa-fA-FbBoOjJ]/.test(code[j])) j++;
      tokens.push({ type: "number", value: code.slice(i, j) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[a-zA-Z0-9_]/.test(code[j])) j++;
      const word = code.slice(i, j);
      tokens.push({ type: PYTHON_KEYWORDS.has(word) ? "keyword" : "identifier", value: word });
      i = j;
      continue;
    }

    if (/[+\-*/%=!<>&|^~@]/.test(code[i])) {
      tokens.push({ type: "operator", value: code[i] });
      i++;
      continue;
    }

    tokens.push({ type: "punctuation", value: code[i] });
    i++;
  }

  return tokens;
}

type Language = "ts" | "tsx" | "js" | "jsx" | "json" | "python" | "py";

/**
 * Apply ANSI syntax highlighting to a code snippet.
 * @param code - Source code string
 * @param language - Optional language hint. Defaults to "ts".
 * @returns ANSI-colored string for terminal output.
 */
export function highlight(code: string, language: Language | string = "ts"): string {
  const lang = language.toLowerCase();
  let tokens: Token[];

  if (lang === "json") {
    tokens = tokenizeJsTsJson(code, true);
  } else if (lang === "py" || lang === "python") {
    tokens = tokenizePython(code);
  } else {
    tokens = tokenizeJsTsJson(code, false);
  }

  return tokens.map((t) => colors[t.type](t.value)).join("");
}
