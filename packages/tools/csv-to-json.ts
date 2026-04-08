/**
 * Parses CSV text into an array of objects.
 * @param csv - The CSV text to parse.
 * @param trimFields - If true, trims whitespace from each field.
 * @returns Array of objects with headers as keys and row values as values.
 */
export function parse(csv: string, trimFields: boolean = false): object[] {
  const lines = csv.split('\n');
  if (lines.length === 0) return [];
  const headers = splitLine(lines[0]);
  const result: object[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const fields = splitLine(line);
    if (fields.length !== headers.length) continue;
    const row: { [key: string]: string } = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const value = trimFields ? fields[j].trim() : fields[j];
      row[key] = value;
    }
    result.push(row);
  }
  return result;
}

function splitLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      inQuotes = false;
    } else if (char === ',' && !inQuotes) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}