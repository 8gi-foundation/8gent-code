/**
 * Detects the frontmatter format (yaml or toml) from the content.
 * @param content - The content to check.
 * @returns 'yaml' if YAML frontmatter is detected, 'toml' if TOML, otherwise null.
 */
function detect(content: string): 'yaml' | 'toml' | null {
  if (content.startsWith('---')) return 'yaml';
  if (content.startsWith('+++')) return 'toml';
  return null;
}

/**
 * Parses YAML or TOML frontmatter from the content.
 * @param content - The content to parse.
 * @returns An object with parsed data and the body.
 */
function parse(content: string): { data: Record<string, unknown>, body: string } {
  const format = detect(content);
  if (!format) return { data: {}, body: content };
  const delimiter = format === 'yaml' ? '---' : '+++';
  const firstIndex = 0;
  const secondIndex = content.indexOf(delimiter, firstIndex + delimiter.length);
  let frontmatter = '';
  let body = content;
  if (secondIndex !== -1) {
    frontmatter = content.slice(firstIndex + delimiter.length, secondIndex).trim();
    body = content.slice(secondIndex + delimiter.length).trim();
  } else {
    frontmatter = content.slice(firstIndex + delimiter.length).trim();
  }
  return { data: parseFrontmatter(frontmatter, format), body };
}

/**
 * Serializes data into YAML or TOML frontmatter format.
 * @param data - The data to serialize.
 * @param body - The body content.
 * @param format - The format to use (yaml or toml).
 * @returns The serialized string with frontmatter and body.
 */
function stringify(data: Record<string, unknown>, body: string, format: 'yaml' | 'toml'): string {
  const lines = Object.entries(data).map(([k, v]) => {
    return format === 'yaml' ? `${k}: ${v}` : `${k} = ${v}`;
  });
  const frontmatter = lines.join('\n') + '\n';
  const delimiter = format === 'yaml' ? '---' : '+++';
  return `${delimiter}\n${frontmatter}${delimiter}\n${body}`;
}

/**
 * Internal helper to parse frontmatter content into a data object.
 * @param frontmatter - The frontmatter string.
 * @param format - The format (yaml or toml).
 * @returns Parsed data object.
 */
function parseFrontmatter(frontmatter: string, format: 'yaml' | 'toml'): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = frontmatter.split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    const [key, value] = format === 'yaml'
      ? line.split(':', 2).map(s => s.trim())
      : line.split('=', 2).map(s => s.trim());
    if (key) data[key] = value;
  }
  return data;
}

export { detect, parse, stringify };