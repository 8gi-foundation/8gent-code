/**
 * Code Complexity Analyzer
 * Calculates cyclomatic and cognitive complexity for TypeScript functions.
 *
 * Cyclomatic complexity: counts decision points (branches) + 1.
 * Cognitive complexity: penalizes nesting depth and structural breaks.
 */

export interface ComplexityResult {
  functionName: string;
  cyclomatic: number;
  cognitive: number;
  nestingDepth: number;
  lineStart: number;
  lineEnd: number;
}

export interface FileComplexityResult {
  functions: ComplexityResult[];
  fileCyclomatic: number;
  fileCognitive: number;
  hotspots: ComplexityResult[];
}

const CYCLOMATIC_TOKENS = [
  /\bif\b/,
  /\belse if\b/,
  /\bfor\b/,
  /\bwhile\b/,
  /\bdo\b/,
  /\bcase\b/,
  /\bcatch\b/,
  /\?\?/,
  /\?\./,
  /\?[^:]/,
  /&&/,
  /\|\|/,
];

const COGNITIVE_TOKENS: Array<{ re: RegExp; nestingIncrement: boolean }> = [
  { re: /\bif\b/, nestingIncrement: true },
  { re: /\belse if\b/, nestingIncrement: false },
  { re: /\belse\b/, nestingIncrement: false },
  { re: /\bfor\b/, nestingIncrement: true },
  { re: /\bwhile\b/, nestingIncrement: true },
  { re: /\bdo\b/, nestingIncrement: true },
  { re: /\bswitch\b/, nestingIncrement: true },
  { re: /\bcatch\b/, nestingIncrement: false },
  { re: /\bcontinue\b/, nestingIncrement: false },
  { re: /\bbreak\b/, nestingIncrement: false },
  { re: /\?\?/, nestingIncrement: false },
  { re: /&&/, nestingIncrement: false },
  { re: /\|\|/, nestingIncrement: false },
];

function countCyclomatic(body: string): number {
  let count = 1;
  const lines = body.split("\n");
  for (const line of lines) {
    const stripped = line.replace(/\/\/.*$/, "").replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    for (const token of CYCLOMATIC_TOKENS) {
      const matches = stripped.match(new RegExp(token.source, "g"));
      if (matches) count += matches.length;
    }
  }
  return count;
}

function countCognitive(body: string): { cognitive: number; maxDepth: number } {
  let cognitive = 0;
  let depth = 0;
  let maxDepth = 0;
  const lines = body.split("\n");
  for (const line of lines) {
    const stripped = line.replace(/\/\/.*$/, "").replace(/"[^"]*"/g, '""');
    const opens = (stripped.match(/\{/g) || []).length;
    const closes = (stripped.match(/\}/g) || []).length;
    for (const token of COGNITIVE_TOKENS) {
      if (token.re.test(stripped)) {
        cognitive += token.nestingIncrement ? 1 + depth : 1;
      }
    }
    depth += opens - closes;
    if (depth < 0) depth = 0;
    if (depth > maxDepth) maxDepth = depth;
  }
  return { cognitive, maxDepth };
}

function extractFunctions(
  code: string
): Array<{ name: string; body: string; lineStart: number; lineEnd: number }> {
  const lines = code.split("\n");
  const results: Array<{ name: string; body: string; lineStart: number; lineEnd: number }> = [];
  const fnPattern =
    /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(|(\w+)\s*(?::\s*\w+\s*)?\(.*\)\s*(?::\s*\w+\s*)?\{)/;
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(fnPattern);
    if (match) {
      const name = match[1] || match[2] || match[3] || "anonymous";
      const lineStart = i + 1;
      let braceCount = 0;
      let started = false;
      const bodyLines: string[] = [];
      for (let j = i; j < lines.length; j++) {
        const l = lines[j];
        braceCount += (l.match(/\{/g) || []).length;
        braceCount -= (l.match(/\}/g) || []).length;
        bodyLines.push(l);
        if (braceCount > 0) started = true;
        if (started && braceCount <= 0) {
          results.push({ name, body: bodyLines.join("\n"), lineStart, lineEnd: j + 1 });
          i = j;
          break;
        }
      }
    }
    i++;
  }
  return results;
}

/**
 * Analyze cyclomatic and cognitive complexity for all functions in a TypeScript source string.
 */
export function analyzeComplexity(code: string): FileComplexityResult {
  const fns = extractFunctions(code);
  const functions: ComplexityResult[] = fns.map((fn) => {
    const cyclomatic = countCyclomatic(fn.body);
    const { cognitive, maxDepth } = countCognitive(fn.body);
    return {
      functionName: fn.name,
      cyclomatic,
      cognitive,
      nestingDepth: maxDepth,
      lineStart: fn.lineStart,
      lineEnd: fn.lineEnd,
    };
  });
  const fileCyclomatic = functions.reduce((sum, f) => sum + f.cyclomatic, 0);
  const fileCognitive = functions.reduce((sum, f) => sum + f.cognitive, 0);
  const hotspots = functions.filter((f) => f.cyclomatic > 10 || f.cognitive > 15);
  return { functions, fileCyclomatic, fileCognitive, hotspots };
}
