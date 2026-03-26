type Entry = {
  projectId: string;
  start: Date;
  end?: Date;
};

/**
 * Starts a timer for the given project.
 * @param projectId - The project ID.
 * @returns The timer entry with start timestamp.
 */
export function startTimer(projectId: string): Entry {
  return { projectId, start: new Date(), end: undefined };
}

/**
 * Stops a timer entry and returns the duration in minutes.
 * @param entry - The timer entry to stop.
 * @returns The duration in minutes.
 */
export function stopTimer(entry: Entry): number {
  const end = new Date();
  entry.end = end;
  const diff = end.getTime() - entry.start.getTime();
  return diff / (1000 * 60);
}

/**
 * Logs a manual time entry.
 * @param projectId - The project ID.
 * @param startISO - Start timestamp in ISO format.
 * @param endISO - End timestamp in ISO format.
 * @returns The manual entry.
 */
export function logManual(projectId: string, startISO: string, endISO: string): Entry {
  return {
    projectId,
    start: new Date(startISO),
    end: new Date(endISO)
  };
}

/**
 * Generates a summary of time entries with billing rates.
 * @param entries - Array of timer entries.
 * @param rateMap - Map of project IDs to billing rates.
 * @returns Summary with project hours, rate, amount, and total.
 */
export function summary(entries: Entry[], rateMap: Map<string, number>): { items: { project: string; hours: number; rate: number; amount: number }[]; total: number } {
  const grouped = entries.reduce((acc, entry) => {
    const projectId = entry.projectId;
    const duration = entry.end ? (entry.end.getTime() - entry.start.getTime()) / (1000 * 60) : 0;
    if (!acc[projectId]) {
      acc[projectId] = { hours: 0, rate: rateMap.get(projectId) || 0 };
    }
    acc[projectId].hours += duration;
    return acc;
  }, {} as Record<string, { hours: number; rate: number }>);

  const items = Object.entries(grouped).map(([project, { hours, rate }]) => ({
    project,
    hours,
    rate,
    amount: hours * rate
  }));

  const total = items.reduce((sum, item) => sum + item.amount, 0);

  return { items, total };
}

/**
 * Formats summary for invoice generator compatibility.
 * @param summary - Summary data from summary function.
 * @returns Array of invoice line items.
 */
export function toInvoiceLines(summary: { items: { project: string; hours: number; rate: number; amount: number }[]; total: number }): { description: string; quantity: number; rate: number; amount: number }[] {
  return summary.items.map(item => ({
    description: item.project,
    quantity: item.hours,
    rate: item.rate,
    amount: item.amount
  }));
}