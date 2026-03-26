/**
 * Represents an audit log entry.
 */
interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  details?: string;
}

/**
 * Append-only audit log implementation.
 */
class AuditLog {
  private entries: AuditEntry[] = [];

  /**
   * Logs a new audit entry.
   * @param action - The action performed.
   * @param actor - The actor who performed the action.
   * @param details - Optional additional details.
   */
  log(action: string, actor: string, details?: string): void {
    this.entries.push({
      id: this.generateId(),
      timestamp: new Date().toISOString(),
      action,
      actor,
      details
    });
  }

  /**
   * Queries audit entries based on a filter function.
   * @param filter - Function to test each entry.
   * @returns Matching entries.
   */
  query(filter: (entry: AuditEntry) => boolean): AuditEntry[] {
    return this.entries.filter(filter);
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

/**
 * Exports audit entries as CSV.
 * @param entries - Entries to export.
 * @returns CSV-formatted string.
 */
function toCSV(entries: AuditEntry[]): string {
  const headers = ['id', 'timestamp', 'action', 'actor', 'details'];
  const rows = entries.map(entry => [
    entry.id,
    entry.timestamp,
    entry.action,
    entry.actor,
    entry.details || ''
  ].map(field => `"${field.replace(/"/g, '""')}"`).join(','));
  return [headers.join(','), ...rows].join('\n');
}

export { AuditLog, toCSV, AuditEntry };