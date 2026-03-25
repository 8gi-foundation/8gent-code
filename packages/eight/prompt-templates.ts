/**
 * PromptTemplate - zero-dependency template engine for Eight agent prompts.
 *
 * Syntax:
 *   {{variable}}                     - interpolation
 *   {{#if condition}}...{{/if}}      - conditional block
 *   {{#unless condition}}...{{/unless}} - inverted conditional
 *   {{#each items}}...{{/each}}      - loop over array
 *   {{@index}}                       - loop index (inside each)
 *   {{@first}} {{@last}}             - loop position flags (inside each)
 *   {{> partial_name}}               - partial inclusion
 */

export interface TemplateContext {
  [key: string]: unknown;
}

export interface TemplateOptions {
  /** Strict mode: throw on unresolved variables instead of leaving them empty */
  strict?: boolean;
  /** Registered partials keyed by name */
  partials?: Record<string, string>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  variables: string[];
  partials: string[];
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenKind =
  | "text"
  | "variable"
  | "if_open"
  | "unless_open"
  | "if_close"
  | "unless_close"
  | "each_open"
  | "each_close"
  | "partial";

interface Token {
  kind: TokenKind;
  raw: string;
  value: string; // variable name / condition expression / partial name
}

const TAG_RE = /\{\{([\s\S]+?)\}\}/g;

function tokenise(template: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(template)) !== null) {
    const [fullMatch, inner] = match;
    const trimmed = inner.trim();

    if (match.index > lastIndex) {
      tokens.push({
        kind: "text",
        raw: template.slice(lastIndex, match.index),
        value: template.slice(lastIndex, match.index),
      });
    }

    if (trimmed.startsWith("#if ")) {
      tokens.push({ kind: "if_open", raw: fullMatch, value: trimmed.slice(4).trim() });
    } else if (trimmed === "/if") {
      tokens.push({ kind: "if_close", raw: fullMatch, value: "" });
    } else if (trimmed.startsWith("#unless ")) {
      tokens.push({ kind: "unless_open", raw: fullMatch, value: trimmed.slice(8).trim() });
    } else if (trimmed === "/unless") {
      tokens.push({ kind: "unless_close", raw: fullMatch, value: "" });
    } else if (trimmed.startsWith("#each ")) {
      tokens.push({ kind: "each_open", raw: fullMatch, value: trimmed.slice(6).trim() });
    } else if (trimmed === "/each") {
      tokens.push({ kind: "each_close", raw: fullMatch, value: "" });
    } else if (trimmed.startsWith("> ")) {
      tokens.push({ kind: "partial", raw: fullMatch, value: trimmed.slice(2).trim() });
    } else {
      tokens.push({ kind: "variable", raw: fullMatch, value: trimmed });
    }

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < template.length) {
    tokens.push({
      kind: "text",
      raw: template.slice(lastIndex),
      value: template.slice(lastIndex),
    });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function resolve(path: string, stack: TemplateContext[]): unknown {
  // Special loop variables
  if (path === "@index" || path === "@first" || path === "@last") {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (path in stack[i]) return stack[i][path];
    }
    return undefined;
  }

  const parts = path.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    let current: unknown = stack[i];
    let found = true;
    for (const part of parts) {
      if (current != null && typeof current === "object" && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        found = false;
        break;
      }
    }
    if (found) return current;
  }
  return undefined;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  return true;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function render(
  tokens: Token[],
  stack: TemplateContext[],
  options: TemplateOptions,
  partials: Record<string, string>,
  depth: number
): { output: string; consumed: number } {
  if (depth > 64) throw new Error("PromptTemplate: max recursion depth exceeded");

  let output = "";
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    switch (token.kind) {
      case "text":
        output += token.value;
        i++;
        break;

      case "variable": {
        const val = resolve(token.value, stack);
        if (val === undefined && options.strict) {
          throw new Error(`PromptTemplate: unresolved variable "{{${token.value}}}"`);
        }
        output += stringify(val);
        i++;
        break;
      }

      case "if_open": {
        const condition = isTruthy(resolve(token.value, stack));
        const inner = render(tokens.slice(i + 1), stack, options, partials, depth + 1);
        if (condition) output += inner.output;
        i += inner.consumed + 2; // +1 for open, +1 for close
        break;
      }

      case "unless_open": {
        const condition = isTruthy(resolve(token.value, stack));
        const inner = render(tokens.slice(i + 1), stack, options, partials, depth + 1);
        if (!condition) output += inner.output;
        i += inner.consumed + 2;
        break;
      }

      case "if_close":
      case "unless_close":
        // Signal to parent that we've hit the close tag
        return { output, consumed: i };

      case "each_open": {
        const list = resolve(token.value, stack);
        const items = Array.isArray(list) ? list : list != null ? [list] : [];
        const bodyTokens = tokens.slice(i + 1);

        // Find the end of this each block
        const probe = render(bodyTokens, stack, options, partials, depth + 1);
        const bodyLen = probe.consumed;

        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const loopCtx: TemplateContext = {
            ...(typeof item === "object" && item !== null ? (item as TemplateContext) : { this: item }),
            "@index": idx,
            "@first": idx === 0,
            "@last": idx === items.length - 1,
          };
          const rendered = render(bodyTokens.slice(0, bodyLen), [...stack, loopCtx], options, partials, depth + 1);
          output += rendered.output;
        }

        i += bodyLen + 2; // +1 open +1 close
        break;
      }

      case "each_close":
        return { output, consumed: i };

      case "partial": {
        const src = partials[token.value];
        if (!src) {
          if (options.strict) throw new Error(`PromptTemplate: partial "{{> ${token.value}}}" not registered`);
          i++;
          break;
        }
        const pt = new PromptTemplate(src, options);
        const ctx: TemplateContext = stack.reduce((acc, s) => ({ ...acc, ...s }), {});
        output += pt.render(ctx);
        i++;
        break;
      }

      default:
        i++;
    }
  }

  return { output, consumed: i };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class PromptTemplate {
  private readonly source: string;
  private readonly options: Required<TemplateOptions>;
  private readonly tokens: Token[];

  constructor(source: string, options: TemplateOptions = {}) {
    this.source = source;
    this.options = {
      strict: options.strict ?? false,
      partials: options.partials ?? {},
    };
    this.tokens = tokenise(source);
  }

  /** Render the template with the given context. */
  render(context: TemplateContext = {}): string {
    const { output } = render(this.tokens, [context], this.options, this.options.partials, 0);
    return output;
  }

  /** Validate the template: check syntax and list required variables. */
  validate(): ValidationResult {
    const errors: string[] = [];
    const variables = new Set<string>();
    const partialRefs = new Set<string>();

    let ifDepth = 0;
    let unlessDepth = 0;
    let eachDepth = 0;

    for (const token of this.tokens) {
      switch (token.kind) {
        case "variable":
          if (!token.value.startsWith("@")) variables.add(token.value);
          break;
        case "if_open":
          ifDepth++;
          if (!token.value) errors.push("{{#if}} block missing condition expression");
          else variables.add(token.value.split(".")[0]);
          break;
        case "if_close":
          ifDepth--;
          if (ifDepth < 0) errors.push("Unexpected {{/if}} - no matching {{#if}}");
          break;
        case "unless_open":
          unlessDepth++;
          if (!token.value) errors.push("{{#unless}} block missing condition expression");
          else variables.add(token.value.split(".")[0]);
          break;
        case "unless_close":
          unlessDepth--;
          if (unlessDepth < 0) errors.push("Unexpected {{/unless}} - no matching {{#unless}}");
          break;
        case "each_open":
          eachDepth++;
          if (!token.value) errors.push("{{#each}} block missing array expression");
          else variables.add(token.value);
          break;
        case "each_close":
          eachDepth--;
          if (eachDepth < 0) errors.push("Unexpected {{/each}} - no matching {{#each}}");
          break;
        case "partial":
          partialRefs.add(token.value);
          break;
      }
    }

    if (ifDepth > 0) errors.push(`${ifDepth} unclosed {{#if}} block(s)`);
    if (unlessDepth > 0) errors.push(`${unlessDepth} unclosed {{#unless}} block(s)`);
    if (eachDepth > 0) errors.push(`${eachDepth} unclosed {{#each}} block(s)`);

    for (const p of partialRefs) {
      if (!(p in this.options.partials)) {
        errors.push(`Partial "{{> ${p}}}" is referenced but not registered`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      variables: Array.from(variables),
      partials: Array.from(partialRefs),
    };
  }

  /** Return the raw source. */
  toString(): string {
    return this.source;
  }

  /** Register a partial on this instance (returns new instance - immutable). */
  withPartial(name: string, source: string): PromptTemplate {
    return new PromptTemplate(this.source, {
      ...this.options,
      partials: { ...this.options.partials, [name]: source },
    });
  }
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

/**
 * System prompt for a coding agent session.
 *
 * Required variables: agent_name, model, capabilities (array), user_name
 * Optional variables: context, memory_snippets (array), cwd, date
 */
export const SYSTEM_PROMPT_TEMPLATE = new PromptTemplate(
  `You are {{agent_name}}, a self-evolving autonomous coding agent powered by {{model}}.
{{#if user_name}}You are working with {{user_name}}.{{/if}}
{{#if date}}Session date: {{date}}{{/if}}
{{#if cwd}}Working directory: {{cwd}}{{/if}}

## Capabilities
{{#each capabilities}}- {{name}}: {{description}}
{{/each}}
{{#if context}}
## Context
{{context}}
{{/if}}
{{#if memory_snippets}}
## Relevant Memory
{{#each memory_snippets}}- [{{@index}}] {{.}}
{{/each}}
{{/if}}
Be concise. Show your work. Prefer the smallest change that solves the problem.`.trim()
);

/**
 * Task delegation prompt for sub-agents.
 *
 * Required variables: task, parent_agent, tools (array of {name, description})
 * Optional variables: deadline, priority, notes
 */
export const TASK_DELEGATION_TEMPLATE = new PromptTemplate(
  `## Delegated Task
Parent agent: {{parent_agent}}
Task: {{task}}
{{#if priority}}Priority: {{priority}}{{/if}}
{{#if deadline}}Deadline: {{deadline}}{{/if}}

## Available Tools
{{#each tools}}- {{name}}: {{description}}
{{/each}}
{{#if notes}}
## Notes
{{notes}}
{{/if}}
Report results in structured JSON. Include: status, output, errors, duration_ms.`.trim()
);

/**
 * Post-session reflection prompt.
 *
 * Required variables: session_id, actions (array of {tool, result}), goal
 * Optional variables: duration_ms, tokens_used
 */
export const REFLECTION_TEMPLATE = new PromptTemplate(
  `## Session Reflection — {{session_id}}
Goal: {{goal}}
{{#if duration_ms}}Duration: {{duration_ms}}ms{{/if}}
{{#if tokens_used}}Tokens: {{tokens_used}}{{/if}}

## Actions Taken
{{#each actions}}{{@index}}. {{tool}} -> {{result}}
{{/each}}

Evaluate this session. Output JSON with keys:
- goal_achieved: boolean
- quality_score: 0-100
- key_learnings: string[]
- improvements: string[]
- skill_updates: {skill: string, delta: number}[]`.trim()
);

/**
 * Memory injection segment - drop into any system prompt.
 *
 * Required variables: memories (array of {content, relevance_score, type})
 */
export const MEMORY_INJECTION_TEMPLATE = new PromptTemplate(
  `## Recalled Memory (sorted by relevance)
{{#each memories}}[{{type}}] ({{relevance_score}}) {{content}}
{{/each}}`.trim()
);

/**
 * Error recovery prompt.
 *
 * Required variables: error_message, failed_action, context
 * Optional variables: attempts, max_attempts, suggestions (array)
 */
export const ERROR_RECOVERY_TEMPLATE = new PromptTemplate(
  `## Error Recovery
Failed action: {{failed_action}}
Error: {{error_message}}
{{#if attempts}}Attempt {{attempts}}{{#if max_attempts}} of {{max_attempts}}{{/if}}{{/if}}

Context:
{{context}}
{{#if suggestions}}
## Suggested Next Steps
{{#each suggestions}}- {{.}}
{{/each}}
{{/if}}
Diagnose the root cause and propose the single smallest fix.`.trim()
);

/**
 * Code review prompt.
 *
 * Required variables: diff, repo, branch
 * Optional variables: pr_title, pr_description, checklist (array of strings)
 */
export const CODE_REVIEW_TEMPLATE = new PromptTemplate(
  `## Code Review Request
Repository: {{repo}}
Branch: {{branch}}
{{#if pr_title}}PR: {{pr_title}}{{/if}}
{{#if pr_description}}
Description:
{{pr_description}}
{{/if}}
\`\`\`diff
{{diff}}
\`\`\`
{{#if checklist}}
## Checklist
{{#each checklist}}- [ ] {{.}}
{{/each}}
{{/if}}
Review for: correctness, security, performance, style. Output structured JSON.`.trim()
);

/** Registry of all built-in templates by name. */
export const BUILT_IN_TEMPLATES: Record<string, PromptTemplate> = {
  system_prompt: SYSTEM_PROMPT_TEMPLATE,
  task_delegation: TASK_DELEGATION_TEMPLATE,
  reflection: REFLECTION_TEMPLATE,
  memory_injection: MEMORY_INJECTION_TEMPLATE,
  error_recovery: ERROR_RECOVERY_TEMPLATE,
  code_review: CODE_REVIEW_TEMPLATE,
};

/** Convenience: render a named built-in template. */
export function renderBuiltin(name: keyof typeof BUILT_IN_TEMPLATES, context: TemplateContext): string {
  const tpl = BUILT_IN_TEMPLATES[name];
  if (!tpl) throw new Error(`PromptTemplate: unknown built-in "${name}"`);
  return tpl.render(context);
}
