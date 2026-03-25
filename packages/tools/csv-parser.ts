/**
 * CSV Parser and Generator
 * Handles quoted fields, custom delimiters, header-based object mapping.
 */

export interface ParseOptions {
  delimiter?: string;
  hasHeaders?: boolean;
  skipEmptyLines?: boolean;
}

export interface GenerateOptions {
  delimiter?: string;
  quoteAll?: boolean;
}

export function parseCSV(input: string, options: ParseOptions = {}): string[][] | Record<string, string>[] {
  const delimiter = options.delimiter ?? ",";
  const hasHeaders = options.hasHeaders ?? false;
  const skipEmptyLines = options.skipEmptyLines ?? true;
  const rows = parseRows(input, delimiter);
  const filtered = skipEmptyLines
    ? rows.filter((row) => row.some((cell) => cell.trim() !== ""))
    : rows;
  if (filtered.length === 0) return [];
  if (!hasHeaders) return filtered;
  const [headerRow, ...dataRows] = filtered;
  return dataRows.map((row) => {
    const obj: Record<string, string> = {};
    headerRow.forEach((header, i) => { obj[header] = row[i] ?? ""; });
    return obj;
  });
}

export function generateCSV(
  data: string[][] | Record<string, string>[],
  headers?: string[],
  options: GenerateOptions = {}
): string {
  const delimiter = options.delimiter ?? ",";
  const quoteAll = options.quoteAll ?? false;
  if (data.length === 0) return "";
  const isObjectArray = !Array.isArray(data[0]);
  if (isObjectArray) {
    const objData = data as Record<string, string>[];
    const cols = headers ?? Object.keys(objData[0]);
    const hdr = cols.map((h) => escapeField(h, delimiter, quoteAll));
    const rows = objData.map((obj) =>
      cols.map((col) => escapeField(obj[col] ?? "", delimiter, quoteAll))
    );
    return [hdr, ...rows].map((r) => r.join(delimiter)).join("\n");
  }
  const arrData = data as string[][];
  const allRows = headers ? [headers, ...arrData] : arrData;
  return allRows
    .map((row) => row.map((cell) => escapeField(cell, delimiter, quoteAll)).join(delimiter))
    .join("\n");
}

function parseRows(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const push = () => { row.push(field); field = ""; };
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
      } else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (input.startsWith(delimiter, i)) { push(); i += delimiter.length; continue; }
      else if (ch === "\r" && input[i + 1] === "\n") { push(); rows.push(row); row = []; i += 2; continue; }
      else if (ch === "\n") { push(); rows.push(row); row = []; }
      else { field += ch; }
    }
    i++;
  }
  push();
  if (row.length > 0) rows.push(row);
  return rows;
}

function escapeField(value: string, delimiter: string, quoteAll: boolean): string {
  const needsQuoting = quoteAll || value.includes('"') || value.includes(delimiter)
    || value.includes("\n") || value.includes("\r");
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '\"\"\')}"`;
}
