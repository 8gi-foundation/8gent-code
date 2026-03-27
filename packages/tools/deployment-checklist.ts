/**
 * Represents a deployment checklist item status.
 */
interface ItemStatus {
  status: 'complete' | 'failed' | 'pending';
  timestamp: Date;
  notes: string;
}

/**
 * Represents a deployment checklist with environment-specific items and status tracking.
 */
class Checklist {
  environment: string;
  items: Map<string, ItemStatus>;

  /**
   * Creates a new checklist for the specified environment.
   * @param environment - Target environment (e.g., 'production', 'staging')
   * @param items - Array of item IDs to include
   */
  constructor(environment: string, items: string[]) {
    this.environment = environment;
    this.items = new Map();
    items.forEach(id => {
      this.items.set(id, { status: 'pending', timestamp: new Date(), notes: '' });
    });
  }

  /**
   * Marks a checklist item as complete or failed with a timestamp and notes.
   * @param id - Item ID to update
   * @param status - 'complete' or 'failed' status
   * @param notes - Optional notes about the check result
   */
  check(id: string, status: 'complete' | 'failed', notes: string): void {
    const item = this.items.get(id);
    if (item) {
      item.status = status;
      item.timestamp = new Date();
      item.notes = notes;
    }
  }

  /**
   * Evaluates deployment readiness based on checklist status.
   * @returns Object with readiness status, blocking issues, and warnings
   */
  readiness(): { ready: boolean; blocking: string[]; warnings: string[] } {
    const blocking: string[] = [];
    const warnings: string[] = [];
    for (const [id, item] of this.items.entries()) {
      if (item.status === 'failed') blocking.push(id);
      else if (item.status === 'pending') warnings.push(id);
    }
    return { ready: blocking.length === 0 && warnings.length === 0, blocking, warnings };
  }

  /**
   * Generates rollback steps for failed checklist items.
   * @returns Array of rollback steps for failed items
   */
  rollbackPlan(): string[] {
    const steps: string[] = [];
    for (const [id, item] of this.items.entries()) {
      if (item.status === 'failed') steps.push(`Rollback ${id}: ${item.notes}`);
    }
    return steps;
  }

  /**
   * Generates a formatted deployment readiness report.
   * @returns Formatted checklist report as a string
   */
  renderChecklist(): string {
    const { ready, blocking, warnings } = this.readiness();
    let report = `Environment: ${this.environment}\n\n`;
    for (const [id, item] of this.items.entries()) {
      report += `${id}: ${item.status} @ ${item.timestamp} - ${item.notes}\n`;
    }
    report += `\nReadiness: ${ready ? 'Ready' : 'Not ready'}\n`;
    if (blocking.length > 0) report += `Blocking issues: ${blocking.join(', ')}\n`;
    if (warnings.length > 0) report += `Warnings: ${warnings.join(', ')}\n`;
    return report;
  }
}

/**
 * Creates a new deployment checklist for the specified environment with the given items.
 * @param environment - The target environment (e.g., 'production', 'staging')
 * @param items - Array of item IDs to include in the checklist
 * @returns A new Checklist instance
 */
function createChecklist(environment: string, items: string[]): Checklist {
  return new Checklist(environment, items);
}

export { createChecklist, Checklist };