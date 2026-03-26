/**
 * Extracts the first valid JSON block from text.
 * @param text - Input text containing potential JSON.
 * @returns Parsed JSON object/array or null if invalid.
 */
function extractJSON(text: string): any | null {
  const match = text.match(/({.*?})|(\[.*?\])/s);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extracts bulleted or numbered lists as strings.
 * @param text - Input text containing list items.
 * @returns Array of list items.
 */
function extractList(text: string): string[] {
  return text
    .split('\n')
    .filter(line => /^(\*|\d+\.)/.test(line))
    .map(line => line.replace(/^(\*|\d+\.)\s*/, ''));
}

/**
 * Parses Key: Value patterns into an object.
 * @param text - Input text containing key-value pairs.
 * @returns Object with keys and values.
 */
function extractKeyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  text.split('\n').forEach(line => {
    const parts = line.split(':', 2);
    if (parts.length === 2) {
      result[parts[0].trim()] = parts[1].trim();
    }
  });
  return result;
}

/**
 * Extracts all fenced code blocks with language.
 * @param text - Input text containing code blocks.
 * @returns Array of objects with lang and code.
 */
function extractCodeBlocks(text: string): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  const matches = text.match(/