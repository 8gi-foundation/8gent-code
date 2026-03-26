/**
 * Generates a verbose description from node metadata.
 * @param node - The node object containing metadata.
 * @returns A verbose description string.
 */
function describe(node: any): string {
  return `Node with role "${node.role}" and label "${node.label}"`;
}

/**
 * Expands known abbreviations in the text.
 * @param text - The input text containing abbreviations.
 * @param expansions - A map of abbreviations to their full forms.
 * @returns The text with abbreviations expanded.
 */
function abbreviate(text: string, expansions: Record<string, string>): string {
  return text.replace(/\b([A-Z]{2,})\b/g, (match, abbr) => expansions[abbr] || match);
}

/**
 * Describes the structure of a table.
 * @param rows - Array of table rows.
 * @param cols - Array of table columns.
 * @returns A description of the table's structure.
 */
function tableCaption(rows: any[], cols: any[]): string {
  return `A table with ${rows.length} rows and ${cols.length} columns`;
}

/**
 * Generates progress text for a task.
 * @param value - Current value.
 * @param max - Maximum value.
 * @param label - Optional label for the progress.
 * @returns A string indicating progress.
 */
function progressText(value: number, max: number, label?: string): string {
  const percent = Math.round((value / max) * 100);
  let result = `${percent}% complete`;
  if (label) {
    result += `: ${label}`;
  }
  return result;
}

export { describe, abbreviate, tableCaption, progressText };