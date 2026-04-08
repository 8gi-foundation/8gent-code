/**
 * Parses a space-delimited scope string into an array of scope strings.
 * @param scopeString - The input string.
 * @returns Array of scope strings.
 */
function parse(scopeString: string): string[] {
  return scopeString.split(' ').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Checks if all required scopes are present in the granted scopes.
 * @param granted - Array of granted scopes.
 * @param required - Array of required scopes.
 * @returns True if all required scopes are present.
 */
function hasScope(granted: string[], required: string[]): boolean {
  return required.every(r => granted.includes(r));
}

/**
 * Checks if any of the scopes in anyOf are present in the granted scopes.
 * @param granted - Array of granted scopes.
 * @param anyOf - Array of scopes to check for intersection.
 * @returns True if any of the anyOf scopes are present.
 */
function hasAnyScope(granted: string[], anyOf: string[]): boolean {
  return anyOf.some(a => granted.includes(a));
}

/**
 * Expands wildcard scopes based on the provided definitions.
 * @param scope - The scope string with wildcards.
 * @param definitions - A map of scope prefixes to their possible sub-scopes.
 * @returns Array of expanded scope strings.
 */
function expand(scope: string, definitions: Record<string, string[]>): string[] {
  const parts = scope.split('.');
  const wildcards = parts.map((p, i) => p === '*' ? i : -1).filter(i => i !== -1);
  if (wildcards.length === 0) return [scope];
  const firstWildcard = wildcards[0];
  const prefix = parts.slice(0, firstWildcard).join('.');
  const replacements = definitions[prefix] || [];
  return replacements.flatMap(replacement => {
    const newParts = [...parts];
    newParts[firstWildcard] = replacement;
    return expand(newParts.join('.'), definitions);
  });
}

export { parse, hasScope, hasAnyScope, expand };