/**
 * Parses a cron expression into its constituent fields.
 * @param expression - The cron expression string.
 * @returns An object with minute, hour, day, month, and weekday as arrays of numbers.
 */
function parse(expression: string): { minute: number[], hour: number[], day: number[], month: number[], weekday: number[] } {
  const parts = expression.split(' ').map(p => p.trim());
  if (parts.length !== 5) throw new Error('Invalid cron expression');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    weekday: parseField(parts[4], 0, 6)
  };
}

/**
 * Validates a cron expression.
 * @param expression - The cron expression string.
 * @returns An object with valid boolean and errors array.
 */
function validate(expression: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { minute, hour, day, month, weekday } = parse(expression);
  if (minute.length === 0) errors.push('Minute field is empty');
  if (hour.length === 0) errors.push('Hour field is empty');
  if (day.length === 0) errors.push('Day field is empty');
  if (month.length === 0) errors.push('Month field is empty');
  if (weekday.length === 0) errors.push('Weekday field is empty');
  return { valid: errors.length === 0, errors };
}

/**
 * Finds the next date matching the cron expression.
 * @param expression - The cron expression string.
 * @param from - Optional start date.
 * @returns The next matching Date.
 */
function nextRun(expression: string, from?: Date): Date {
  const { minute, hour, day, month, weekday } = parse(expression);
  const start = from || new Date();
  if (matches(start, minute, hour, day, month, weekday)) return new Date(start);
  let date = new Date(start);
  while (true) {
    date.setMinutes(date.getMinutes() + 1);
    if (matches(date, minute, hour, day, month, weekday)) return new Date(date);
  }
}

/**
 * Generates a human-readable description of the cron expression.
 * @param expression - The cron expression string.
 * @returns A human-readable string.
 */
function describe(expression: string): string {
  const { minute, hour, day, month, weekday } = parse(expression);
  const parts = [];
  parts.push(...describeField('minute', minute));
  parts.push(...describeField('hour', hour));
  parts.push(...describeField('day', day));
  parts.push(...describeField('month', month));
  parts.push(...describeField('weekday', weekday));
  return parts.join(' ');
}

/**
 * Finds the next N dates matching the cron expression.
 * @param expression - The cron expression string.
 * @param n - Number of upcoming runs.
 * @param from - Optional start date.
 * @returns An array of Date objects.
 */
function upcomingRuns(expression: string, n: number, from?: Date): Date[] {
  const runs: Date[] = [];
  let current = nextRun(expression, from);
  for (let i = 0; i < n; i++) {
    runs.push(new Date(current));
    current = nextRun(expression, current);
  }
  return runs;
}

// Helper functions
function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') return [...Array(max - min + 1).keys()].map(i => i + min);
  const tokens = field.split(',').map(t => t.trim());
  const result = new Set<number>();
  for (const token of tokens) {
    if (token.includes('-')) {
      const [start, end] = token.split('-').map(Number);
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) result.add(i);
      }
    } else if (token.includes('/')) {
      const [base, step] = token.split('/').map(Number);
      for (let i = base; i <= max; i += step) {
        result.add(i);
      }
    } else {
      const num = parseInt(token, 10);
      if (!isNaN(num) && num >= min && num <= max) {
        result.add(num);
      }
    }
  }
  return [...result].sort((a, b) => a - b);
}

function matches(date: Date, minute: number[], hour: number[], day: number[], month: number[], weekday: number[]): boolean {
  const d = new Date(date);
  const m = d.getMinutes();
  const h = d.getHours();
  const dayOfMonth = d.getDate();
  const monthNum = d.getMonth() + 1;
  const weekdayNum = d.getDay();
  return minute.includes(m) && hour.includes(h) && day.includes(dayOfMonth) && month.includes(monthNum) && weekday.includes(weekdayNum);
}

function describeField(field: string, values: number[]): string[] {
  if (values.length === 0) return [];
  if (values.includes(0) && values.includes(1) && values.includes(2) && values.includes(3) && values.includes(4) && values.includes(5) && values.includes(6) && values.includes(7) && values.includes(8) && values.includes(9) && values.includes(10) && values.includes(11) && values.includes(12) && values.includes(13) && values.includes(14) && values.includes(15) && values.includes(16) && values.includes(17) && values.includes(18) && values.includes(19) && values.includes(20) && values.includes(21) && values.includes(22) && values.includes(23)) {
    return [`${field} every`];
  } else if (values.length === 1) {
    return [`${values[0]} ${field}`];
  } else if (values.length === 2) {
    return [`${values[0]} and ${values[1]} ${field}`];
  } else {
    return [`${values[0]} to ${values[values.length - 1]} ${field}`];
  }
}

export { parse, validate, nextRun, describe, upcomingRuns };