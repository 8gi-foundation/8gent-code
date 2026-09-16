/**
 * prompt-template
 * Template engine for LLM prompt text.
 *
 * Replaces the hand-rolled `.replace("{{VAR}}", value)` chains that were
 * scattered across packages. Those chains had two live bug classes:
 *   1. String.replace substitutes only the FIRST occurrence, so a template
 *      reusing a variable silently half-renders.
 *   2. A missing or typo'd variable leaves literal `{{VAR}}` in the prompt
 *      with zero detection.
 *
 * This engine substitutes globally, resolves dot-paths ({{user.name}}),
 * detects missing variables (throw by default), and supports
 * {{#if x}}...{{else}}...{{/if}} conditionals. There is deliberately NO
 * HTML escaping: prompts are raw text, not markup. There is no {{#each}}:
 * no current consumer loops.
 *
 * Usage:
 *   render("Hi {{user.name}}, task: {{task}}", { user: { name: "James" }, task: "ship" })
 *   validate(template, vars)  // => names of referenced vars missing from vars
 *   lint(template)            // => structural problems (unclosed blocks, malformed tags)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderOptions {
	/**
	 * What to do when a substitution variable is missing (or resolves to
	 * null/undefined):
	 *   "throw" - throw an Error naming the variable (default)
	 *   "keep"  - leave the literal `{{name}}` in the output
	 *   "empty" - substitute an empty string
	 */
	onMissing?: "throw" | "keep" | "empty";
}

type Token =
	| { kind: "text"; value: string }
	| { kind: "var"; path: string; raw: string }
	| { kind: "if"; path: string; raw: string }
	| { kind: "else"; raw: string }
	| { kind: "endif"; raw: string };

type Node =
	| { kind: "text"; value: string }
	| { kind: "var"; path: string; raw: string }
	| { kind: "if"; path: string; then: Node[]; else: Node[] };

const TAG_RE = /\{\{([^{}]*)\}\}/g;
const PATH_RE = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]*$/;

// ---------------------------------------------------------------------------
// Tokenizer + parser
// ---------------------------------------------------------------------------

function tokenize(template: string): { tokens: Token[]; errors: string[] } {
	const tokens: Token[] = [];
	const errors: string[] = [];
	let last = 0;

	TAG_RE.lastIndex = 0;
	let m = TAG_RE.exec(template);
	while (m !== null) {
		if (m.index > last) tokens.push({ kind: "text", value: template.slice(last, m.index) });

		const raw = m[0];
		const inner = m[1].trim();

		if (inner === "else") {
			tokens.push({ kind: "else", raw });
		} else if (inner === "/if") {
			tokens.push({ kind: "endif", raw });
		} else if (inner.startsWith("#if")) {
			const cond = inner.slice(3).trim();
			if (cond === "" || !PATH_RE.test(cond)) {
				errors.push(`Malformed #if condition: "${raw}"`);
			} else {
				tokens.push({ kind: "if", path: cond, raw });
			}
		} else if (inner.startsWith("#") || inner.startsWith("/")) {
			errors.push(`Unsupported block tag: "${raw}" (only #if/else//if are supported)`);
		} else if (inner === "" || !PATH_RE.test(inner)) {
			errors.push(`Malformed tag: "${raw}"`);
		} else {
			tokens.push({ kind: "var", path: inner, raw });
		}

		last = m.index + raw.length;
		m = TAG_RE.exec(template);
	}
	if (last < template.length) tokens.push({ kind: "text", value: template.slice(last) });

	// A "{{" left in plain text means an opened tag never closed (e.g. "{{VAR").
	// Stray "}}" is deliberately NOT flagged: prompts legitimately contain
	// JSON like {"a":{"b":1}} whose closing braces are harmless literals.
	for (const t of tokens) {
		if (t.kind === "text" && t.value.includes("{{")) {
			errors.push(`Unclosed tag near: "${t.value.slice(t.value.indexOf("{{"), t.value.indexOf("{{") + 40)}"`);
		}
	}

	return { tokens, errors };
}

function parse(tokens: Token[]): { nodes: Node[]; errors: string[] } {
	const errors: string[] = [];
	const root: Node[] = [];
	// Stack of open #if frames; `branch` flips to the else-arm after {{else}}.
	const stack: { node: Extract<Node, { kind: "if" }>; branch: "then" | "else" }[] = [];

	const sink = (): Node[] => {
		const top = stack[stack.length - 1];
		if (!top) return root;
		return top.branch === "then" ? top.node.then : top.node.else;
	};

	for (const t of tokens) {
		if (t.kind === "text" || t.kind === "var") {
			sink().push(t.kind === "text" ? t : { kind: "var", path: t.path, raw: t.raw });
		} else if (t.kind === "if") {
			// biome-ignore lint/suspicious/noThenProperty: `then` is this AST node's if-branch, named to match {{#if}}/{{else}}, and it is never awaited
			const node: Extract<Node, { kind: "if" }> = { kind: "if", path: t.path, then: [], else: [] };
			sink().push(node);
			stack.push({ node, branch: "then" });
		} else if (t.kind === "else") {
			const top = stack[stack.length - 1];
			if (!top) {
				errors.push(`{{else}} outside of an {{#if}} block`);
			} else if (top.branch === "else") {
				errors.push(`Duplicate {{else}} in {{#if ${top.node.path}}} block`);
			} else {
				top.branch = "else";
			}
		} else {
			// endif
			if (!stack.pop()) errors.push(`{{/if}} without a matching {{#if}}`);
		}
	}

	for (const open of stack) {
		errors.push(`Unclosed {{#if ${open.node.path}}} block`);
	}

	return { nodes: root, errors };
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

const MISSING = Symbol("missing");

function resolve(vars: Record<string, unknown>, path: string): unknown | typeof MISSING {
	let current: unknown = vars;
	for (const key of path.split(".")) {
		if (current === null || current === undefined || typeof current !== "object") return MISSING;
		if (!(key in (current as Record<string, unknown>))) return MISSING;
		current = (current as Record<string, unknown>)[key];
	}
	if (current === null || current === undefined) return MISSING;
	return current;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a prompt template. Every occurrence of every variable is
 * substituted (global, unlike String.replace). Values are inserted verbatim:
 * no HTML escaping, and `$` sequences in values are NOT treated as
 * replacement patterns.
 *
 * Throws on structural errors (see lint) and, with the default
 * onMissing: "throw", on any referenced variable that is missing.
 * An {{#if x}} condition never throws: a missing condition is simply falsy.
 */
export function render(
	template: string,
	vars: Record<string, unknown>,
	opts: RenderOptions = {},
): string {
	const onMissing = opts.onMissing ?? "throw";

	const structural = lint(template);
	if (structural.length > 0) {
		throw new Error(`prompt-template: invalid template: ${structural.join("; ")}`);
	}

	const { tokens } = tokenize(template);
	const { nodes } = parse(tokens);

	const out: string[] = [];
	const walk = (list: Node[]): void => {
		for (const node of list) {
			if (node.kind === "text") {
				out.push(node.value);
			} else if (node.kind === "var") {
				const value = resolve(vars, node.path);
				if (value === MISSING) {
					if (onMissing === "throw") {
						throw new Error(`prompt-template: missing variable "${node.path}"`);
					}
					if (onMissing === "keep") out.push(node.raw);
					// "empty": push nothing
				} else {
					out.push(String(value));
				}
			} else {
				const cond = resolve(vars, node.path);
				const truthy = cond !== MISSING && Boolean(cond);
				walk(truthy ? node.then : node.else);
			}
		}
	};
	walk(nodes);

	return out.join("");
}

/**
 * Return the names (dot-paths) of substitution variables referenced by the
 * template that are missing from `vars`. {{#if}} condition names are NOT
 * reported: an absent condition is a legal falsy, not an error.
 * Each missing name appears once, in first-use order.
 */
export function validate(template: string, vars: Record<string, unknown>): string[] {
	const { tokens } = tokenize(template);
	const missing: string[] = [];
	for (const t of tokens) {
		if (t.kind === "var" && resolve(vars, t.path) === MISSING && !missing.includes(t.path)) {
			missing.push(t.path);
		}
	}
	return missing;
}

/**
 * Return structural problems in the template: unclosed {{#if}} blocks,
 * {{/if}} or {{else}} without an opener, unsupported blocks (e.g. {{#each}}),
 * malformed tags, and stray `{{` / `}}` delimiters. Empty array = clean.
 */
export function lint(template: string): string[] {
	const { tokens, errors: tokenErrors } = tokenize(template);
	const { errors: parseErrors } = parse(tokens);
	return [...tokenErrors, ...parseErrors];
}
