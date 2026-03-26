/**
 * Converts an array of objects to a CSV string.
 * @param rows - Array of objects to convert.
 * @param columns - Optional array of column names. If omitted, columns are auto-detected from the first row.
 * @param separator - Optional separator character (default is comma).
 * @returns CSV string.
 */
export function stringify(rows: Array<Record<string, any>>, columns?: string[], separator = ','): string {
  if (rows.length === 0) return '';
  const headers = columns || Object.keys(rows[0]);
  const escapedRows = rows.map(row => {
    return headers.map(col => {
      const value = row[col];
      const str = String(value || '');
      if (str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(separator);
  });
  return [headers.join(separator), ...escapedRows].join('\n');
}