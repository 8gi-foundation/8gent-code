/**
 * Audit Log - append-only security event log.
 *
 * Logs all security decisions to ~/.8gent/security/audit.jsonl.
 * Supports daily rotation and compressed archival.
 */

import { appendFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

export interface AuditEntry {
  timestamp: number;
  action: string;
  target: string;
  decision: 'allow' | 'deny' | 'approve' | 'block';
  actor: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

function getDateStr(date = new Date()): string {
  return date.toISOString().split('T')[0];
}

export class AuditLog {
  private logDir: string;
  private currentDate: string;

  constructor(logDir?: string) {
    this.logDir = logDir ?? join(homedir(), '.8gent', 'security');
    this.currentDate = getDateStr();
  }

  private getLogPath(dateStr?: string): string {
    return join(this.logDir, `audit-${dateStr ?? this.currentDate}.jsonl`);
  }

  /**
   * Append an entry to the audit log.
   */
  async log(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    await mkdir(this.logDir, { recursive: true });

    // Rotate if date changed
    const today = getDateStr();
    if (today !== this.currentDate) {
      this.currentDate = today;
    }

    const fullEntry: AuditEntry = {
      timestamp: Date.now(),
      ...entry,
    };

    const line = JSON.stringify(fullEntry) + '\n';
    await appendFile(this.getLogPath(), line);
  }

  /**
   * Read entries from a specific date.
   */
  async readEntries(dateStr?: string): Promise<AuditEntry[]> {
    try {
      const content = await readFile(this.getLogPath(dateStr), 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  /**
   * Query entries by filters.
   */
  async query(filters: {
    action?: string;
    decision?: AuditEntry['decision'];
    startDate?: string;
    endDate?: string;
    actor?: string;
  }): Promise<AuditEntry[]> {
    const results: AuditEntry[] = [];

    // Determine date range
    const start = filters.startDate ?? getDateStr();
    const end = filters.endDate ?? getDateStr();

    try {
      const files = await readdir(this.logDir);
      const auditFiles = files
        .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
        .filter((f) => {
          const date = f.replace('audit-', '').replace('.jsonl', '');
          return date >= start && date <= end;
        })
        .sort();

      for (const file of auditFiles) {
        const content = await readFile(join(this.logDir, file), 'utf-8');
        const entries = content
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as AuditEntry);

        for (const entry of entries) {
          if (filters.action && entry.action !== filters.action) continue;
          if (filters.decision && entry.decision !== filters.decision) continue;
          if (filters.actor && entry.actor !== filters.actor) continue;
          results.push(entry);
        }
      }
    } catch {
      // Log dir doesn't exist yet
    }

    return results;
  }

  /**
   * Compress log files older than the specified number of days.
   */
  async compressOld(olderThanDays = 7): Promise<number> {
    let compressed = 0;

    try {
      const files = await readdir(this.logDir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      const cutoffStr = getDateStr(cutoff);

      for (const file of files) {
        if (!file.startsWith('audit-') || !file.endsWith('.jsonl')) continue;
        const date = file.replace('audit-', '').replace('.jsonl', '');
        if (date >= cutoffStr) continue;

        const srcPath = join(this.logDir, file);
        const gzPath = srcPath + '.gz';

        await pipeline(
          createReadStream(srcPath),
          createGzip(),
          createWriteStream(gzPath),
        );

        // Remove original after successful compression
        const { unlink } = await import('node:fs/promises');
        await unlink(srcPath);
        compressed++;
      }
    } catch {
      // Best-effort compression
    }

    return compressed;
  }

  /**
   * Get summary statistics for a date range.
   */
  async getSummary(dateStr?: string): Promise<{
    total: number;
    allowed: number;
    denied: number;
    approved: number;
    blocked: number;
    byAction: Record<string, number>;
  }> {
    const entries = await this.readEntries(dateStr);
    const summary = {
      total: entries.length,
      allowed: 0,
      denied: 0,
      approved: 0,
      blocked: 0,
      byAction: {} as Record<string, number>,
    };

    for (const entry of entries) {
      summary[entry.decision]++;
      summary.byAction[entry.action] = (summary.byAction[entry.action] ?? 0) + 1;
    }

    return summary;
  }
}
