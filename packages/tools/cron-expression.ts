/**
 * cron-expression.ts
 * Parse 5-field cron expressions, calculate next run times, check matches,
 * and generate human-readable descriptions.
 *
 * Supports: ranges (1-5), steps (star/10), lists (1,2,3), wildcards (star)
 * Field order: minute hour day-of-month month day-of-week
 */

export interface CronParsed {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  raw: string;
}

const MONTH_NAMES = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const DOW_NAMES = ["sun","mon","tue","wed","thu","fri","sat"];

function expandField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      let start = min;
      let end = max;
      if (range !== "*") {
        const dashIdx = range.indexOf("-");
        if (dashIdx !== -1) {
          start = parseInt(range.slice(0, dashIdx), 10);
          end = parseInt(range.slice(dashIdx + 1), 10);
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      for (let i = lo; i <= hi; i++) values.add(i);
      continue;
    }

    const num = parseInt(part, 10);
    if (!isNaN(num)) {
      values.add(num);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}

function normalizeExpr(expr: string): string {
  let e = expr.trim().toLowerCase();
  MONTH_NAMES.forEach((n, i) => { e = e.replace(new RegExp(n, "g"), String(i + 1)); });
  DOW_NAMES.forEach((n, i) => { e = e.replace(new RegExp(n, "g"), String(i)); });
  return e;
}

export function parseCron(expr: string): CronParsed {
  const norm = normalizeExpr(expr);
  const parts = norm.split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected 5 fields, got ${parts.length}: "${expr}"`);
  const [m, h, dom, mon, dow] = parts;
  return {
    minute: expandField(m, 0, 59),
    hour: expandField(h, 0, 23),
    dom: expandField(dom, 1, 31),
    month: expandField(mon, 1, 12),
    dow: expandField(dow, 0, 6),
    raw: expr,
  };
}

export function matches(expr: string | CronParsed, date: Date): boolean {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  return (
    cron.minute.includes(date.getMinutes()) &&
    cron.hour.includes(date.getHours()) &&
    cron.dom.includes(date.getDate()) &&
    cron.month.includes(date.getMonth() + 1) &&
    cron.dow.includes(date.getDay())
  );
}

export function nextRun(expr: string | CronParsed, after: Date = new Date(), count = 1): Date[] {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  const results: Date[] = [];

  // Start one minute after the reference time
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = new Date(cursor);
  limit.setFullYear(limit.getFullYear() + 4);

  while (results.length < count && cursor < limit) {
    if (
      cron.month.includes(cursor.getMonth() + 1) &&
      cron.dom.includes(cursor.getDate()) &&
      cron.dow.includes(cursor.getDay()) &&
      cron.hour.includes(cursor.getHours()) &&
      cron.minute.includes(cursor.getMinutes())
    ) {
      results.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  return results;
}

export function describe(expr: string | CronParsed): string {
  const cron = typeof expr === "string" ? parseCron(expr) : expr;
  const raw = typeof expr === "string" ? expr : expr.raw;
  const parts = normalizeExpr(raw).split(/\s+/);

  const minutePart = parts[0] === "*" ? "every minute" : `at minute ${cron.minute.join(", ")}`;
  const hourPart = parts[1] === "*" ? "every hour" : `hour ${cron.hour.join(", ")}`;
  const domPart = parts[2] === "*" ? "every day" : `day ${cron.dom.join(", ")} of the month`;
  const monthPart = parts[3] === "*"
    ? "every month"
    : `in ${cron.month.map(m => MONTH_NAMES[m - 1]).join(", ")}`;
  const dowPart = parts[4] === "*"
    ? ""
    : ` on ${cron.dow.map(d => DOW_NAMES[d]).join(", ")}`;

  if (parts[0] === "0" && parts[1] === "0" && parts[2] === "*" && parts[3] === "*" && parts[4] === "*") {
    return "At midnight every day";
  }
  if (parts[0] === "0" && parts[1] === "*") {
    return `At the top of ${hourPart}${dowPart}`;
  }

  return `Runs ${minutePart} of ${hourPart}, ${domPart}, ${monthPart}${dowPart}`.replace(/\s+/g, " ").trim();
}
