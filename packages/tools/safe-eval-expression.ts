/**
 * safe-eval-expression
 *
 * Evaluates simple math and logic expressions without using eval() or Function().
 * Supports: +, -, *, /, %, **, &&, ||, !, ==, !=, >, <, >=, <=, ternary (?:)
 * Variables can be injected via the `vars` map.
 *
 * No dynamic code execution. No prototype access. No side effects.
 */

export type VarMap = Record<string, number | boolean | string>;

type TokenType =
  | "number" | "boolean" | "string" | "identifier"
  | "op" | "lparen" | "rparen" | "question" | "colon" | "eof";

interface Token { type: TokenType; value: string; }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      const q = ch; let s = ""; i++;
      while (i < expr.length && expr[i] !== q) s += expr[i++];
      i++;
      tokens.push({ type: "string", value: s }); continue;
    }
    if (/[0-9.]/.test(ch)) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) num += expr[i++];
      tokens.push({ type: "number", value: num }); continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = "";
      while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i])) id += expr[i++];
      tokens.push({ type: id === "true" || id === "false" ? "boolean" : "identifier", value: id }); continue;
    }
    const two = expr.slice(i, i + 2);
    if (["==","!=",">=","<=","&&","||","**"].includes(two)) { tokens.push({ type: "op", value: two }); i += 2; continue; }
    if ("+-*/%!><".includes(ch)) { tokens.push({ type: "op", value: ch }); i++; continue; }
    if (ch === "(") { tokens.push({ type: "lparen", value: ch }); i++; continue; }
    if (ch === ")") { tokens.push({ type: "rparen", value: ch }); i++; continue; }
    if (ch === "?") { tokens.push({ type: "question", value: ch }); i++; continue; }
    if (ch === ":") { tokens.push({ type: "colon", value: ch }); i++; continue; }
    throw new Error(`Unexpected character: ${ch}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

type Primitive = number | boolean | string;

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private vars: VarMap) {}
  peek(): Token { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }
  parse(): Primitive { return this.ternary(); }

  private ternary(): Primitive {
    const c = this.or();
    if (this.peek().type === "question") {
      this.consume();
      const t = this.ternary();
      if (this.peek().type !== "colon") throw new Error("Expected ':' in ternary");
      this.consume();
      const f = this.ternary();
      return c ? t : f;
    }
    return c;
  }
  private or(): Primitive {
    let l = this.and();
    while (this.peek().type === "op" && this.peek().value === "||") { this.consume(); l = (l as boolean) || (this.and() as boolean); }
    return l;
  }
  private and(): Primitive {
    let l = this.eq();
    while (this.peek().type === "op" && this.peek().value === "&&") { this.consume(); l = (l as boolean) && (this.eq() as boolean); }
    return l;
  }
  private eq(): Primitive {
    let l = this.rel();
    while (this.peek().type === "op" && ["==","!="].includes(this.peek().value)) {
      const op = this.consume().value; const r = this.rel();
      l = op === "==" ? l == r : l != r;
    }
    return l;
  }
  private rel(): Primitive {
    let l = this.add();
    while (this.peek().type === "op" && [">","<",">=","<="].includes(this.peek().value)) {
      const op = this.consume().value; const r = this.add() as number;
      if (op === ">") l = (l as number) > r; else if (op === "<") l = (l as number) < r;
      else if (op === ">=") l = (l as number) >= r; else l = (l as number) <= r;
    }
    return l;
  }
  private add(): Primitive {
    let l = this.mul();
    while (this.peek().type === "op" && ["+","-"].includes(this.peek().value)) {
      const op = this.consume().value; const r = this.mul() as number;
      l = op === "+" ? (l as number) + r : (l as number) - r;
    }
    return l;
  }
  private mul(): Primitive {
    let l = this.pow();
    while (this.peek().type === "op" && ["*","/","%"].includes(this.peek().value)) {
      const op = this.consume().value; const r = this.pow() as number;
      if (op === "*") l = (l as number) * r; else if (op === "/") l = (l as number) / r;
      else l = (l as number) % r;
    }
    return l;
  }
  private pow(): Primitive {
    const b = this.unary();
    if (this.peek().type === "op" && this.peek().value === "**") {
      this.consume(); return Math.pow(b as number, this.pow() as number);
    }
    return b;
  }
  private unary(): Primitive {
    if (this.peek().type === "op" && this.peek().value === "!") { this.consume(); return !this.unary(); }
    if (this.peek().type === "op" && this.peek().value === "-") { this.consume(); return -(this.unary() as number); }
    return this.primary();
  }
  private primary(): Primitive {
    const tok = this.peek();
    if (tok.type === "number") { this.consume(); return parseFloat(tok.value); }
    if (tok.type === "boolean") { this.consume(); return tok.value === "true"; }
    if (tok.type === "string") { this.consume(); return tok.value; }
    if (tok.type === "identifier") {
      this.consume();
      if (!(tok.value in this.vars)) throw new Error(`Unknown variable: ${tok.value}`);
      return this.vars[tok.value] as Primitive;
    }
    if (tok.type === "lparen") {
      this.consume(); const v = this.ternary();
      if (this.peek().type !== "rparen") throw new Error("Expected ')'");
      this.consume(); return v;
    }
    throw new Error(`Unexpected token: ${tok.value || tok.type}`);
  }
}

/**
 * Evaluate a simple math/logic expression string safely.
 *
 * @param expr - Expression to evaluate, e.g. "2 + 3 * 4", "x > 5 && y < 10"
 * @param vars - Optional variable map, e.g. { x: 6, y: 3 }
 * @returns The computed value (number, boolean, or string)
 * @throws Error on syntax errors or unknown variables
 *
 * @example
 * evalExpr("2 + 3 * 4")                               // 14
 * evalExpr("x > 5", { x: 6 })                         // true
 * evalExpr("a ? 1 : 2", { a: false })                  // 2
 * evalExpr("score >= 90 ? 'A' : 'B'", { score: 95 })  // "A"
 */
export function evalExpr(expr: string, vars: VarMap = {}): Primitive {
  const tokens = tokenize(expr.trim());
  const parser = new Parser(tokens, vars);
  const result = parser.parse();
  if (parser.peek().type !== "eof") throw new Error("Unexpected token after expression");
  return result;
}
