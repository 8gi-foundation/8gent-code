/**
 * output-formatter.ts
 * Formats output for different targets: terminal, JSON, markdown, CSV.
 * Auto-detects TTY for smart default mode selection.
 */

export type OutputMode = "terminal" | "json" | "markdown" | "csv";

export type FormattableValue = string | number | boolean | null | undefined;
export type FormattableRow = Record<string, FormattableValue>;
export type FormattableData =
  | FormattableValue
  | FormattableRow
  | FormattableRow[]
  | FormattableValue[];

function isTTY(): boolean {
  return process.stdout.isTTY === true;
}

function detectMode(): OutputMode {
  return isTTY() ? "terminal" : "json";
}

function toRows(data: FormattableData): FormattableRow[] {
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    if (typeof data[0] === "object" && data[0] !== null) {
      return data as FormattableRow[];
    }
    return (data as FormattableValue[]).map((v, i) => ({ index: i, value: v ?? "" }));
  }
  if (typeof data === "object" && data !== null) {
    return [data as FormattableRow];
  }
  return [{ value: data ?? "" }];
}

function terminalRow(key: string, value: FormattableValue): string {
  const k = key.padEnd(20, " ");
  return `  ${k} ${String(value ?? "")}`;
}

function terminalTable(rows: FormattableRow[]): string {
  if (rows.length === 0) return "(empty)";
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length))
  );
  const header = keys.map((k, i) => k.padEnd(widths[i])).join("  ");
  const divider = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((row) => keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
  return `${header}\n${divider}\n${body}`;
}

export function terminal(data: FormattableData): string {
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean" || data === null || data === undefined) {
    return String(data ?? "");
  }
  const rows = toRows(data);
  if (rows.length === 1 && Object.keys(rows[0]).length <= 2) {
    return Object.entries(rows[0])
      .map(([k, v]) => terminalRow(k, v))
      .join("\n");
  }
  return terminalTable(rows);
}

export function json(data: FormattableData): string {
  return JSON.stringify(data, null, 2);
}

export function markdown(data: FormattableData): string {
  if (typeof data === "string") return data;
  if (typeof data !== "object" || data === null) return String(data ?? "");
  const rows = toRows(data);
  if (rows.length === 0) return "_empty_";
  const keys = Object.keys(rows[0]);
  const header = `| ${keys.join(" | ")} |`;
  const divider = `| ${keys.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((row) => `| ${keys.map((k) => String(row[k] ?? "")).join(" | ")} |`)
    .join("\n");
  return `${header}\n${divider}\n${body}`;
}

function escapeCsvField(value: FormattableValue): string {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csv(data: FormattableData): string {
  const rows = toRows(data);
  if (rows.length === 0) return "";
  const keys = Object.keys(rows[0]);
  const header = keys.map(escapeCsvField).join(",");
  const body = rows
    .map((row) => keys.map((k) => escapeCsvField(row[k])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

export class Formatter {
  private mode: OutputMode;

  constructor(mode?: OutputMode) {
    this.mode = mode ?? detectMode();
  }

  format(data: FormattableData, mode?: OutputMode): string {
    const target = mode ?? this.mode;
    switch (target) {
      case "terminal": return terminal(data);
      case "json":     return json(data);
      case "markdown": return markdown(data);
      case "csv":      return csv(data);
    }
  }

  getMode(): OutputMode {
    return this.mode;
  }
}

export function format(data: FormattableData, mode?: OutputMode): string {
  const f = new Formatter(mode);
  return f.format(data);
}
