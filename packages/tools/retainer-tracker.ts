/**
 * Log entry for retainer tracking
 */
export interface LogEntry {
  date: string;
  description: string;
  hours: number;
}

/**
 * Retainer tracking object
 */
export interface Retainer {
  client: string;
  month: string;
  monthlyHours: number;
  hourlyRate: number;
  logs: LogEntry[];
  totalHours: number;
}

/**
 * Creates a new retainer object
 * @param client - Client name
 * @param monthlyHours - Allocated hours per month
 * @param hourlyRate - Billing rate per hour
 * @param month - Target month (YYYY-MM)
 * @returns New retainer object
 */
export function createRetainer({
  client,
  monthlyHours,
  hourlyRate,
  month,
}: {
  client: string;
  monthlyHours: number;
  hourlyRate: number;
  month: string;
}): Retainer {
  return {
    client,
    month,
    monthlyHours,
    hourlyRate,
    logs: [],
    totalHours: 0,
  };
}

/**
 * Logs hours against a retainer
 * @param retainer - Retainer object
 * @param entry - Date, description, and hours to log
 */
export function logHours(
  retainer: Retainer,
  { date, description, hours }: { date: string; description: string; hours: number }
): void {
  retainer.logs.push({ date, description, hours });
  retainer.totalHours += hours;
}

/**
 * Calculates retainer status
 * @param retainer - Retainer object
 * @returns Status object with used, remaining, overage, and utilization
 */
export function status(retainer: Retainer): {
  used: number;
  remaining: number;
  overage: number;
  utilizationPercent: number;
} {
  const used = retainer.totalHours;
  const remaining = retainer.monthlyHours - used;
  const overage = Math.max(0, used - retainer.monthlyHours);
  const utilizationPercent = (used / retainer.monthlyHours) * 100;
  return { used, remaining, overage, utilizationPercent };
}

/**
 * Renders formatted monthly statement
 * @param retainer - Retainer object
 * @returns Formatted statement string
 */
export function renderStatement(retainer: Retainer): string {
  const { client, month, monthlyHours, hourlyRate, logs, totalHours } = retainer;
  const { used, remaining, overage, utilizationPercent } = status(retainer);
  const overageMessage = overage > 0 ? `Overage: ${overage} hours` : '';
  const totalBill = (monthlyHours + overage) * hourlyRate;
  return `
    Client: ${client}
    Month: ${month}
    Monthly Hours: ${monthlyHours}
    Hourly Rate: $${hourlyRate}
    ${logs.map(
      (entry) => `  ${entry.date} - ${entry.description}: ${entry.hours}h`
    ).join('\n')}
    Total Hours: ${totalHours}
    ${overageMessage}
    Utilization: ${utilizationPercent.toFixed(2)}%
    Total Bill: $${totalBill.toFixed(2)}
  `;
}

/**
 * Triggers warning if utilization exceeds threshold
 * @param retainer - Retainer object
 * @param threshold - Utilization threshold in percent
 */
export function warnOverage(retainer: Retainer, threshold: number): void {
  const { utilizationPercent } = status(retainer);
  if (utilizationPercent >= threshold) {
    console.warn(
      `Warning: ${retainer.client} ${retainer.month} retainer at ${utilizationPercent.toFixed(
        2
      )}% utilization`
    );
  }
}