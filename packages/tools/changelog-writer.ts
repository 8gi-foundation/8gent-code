/**
 * ChangelogWriter - structured changelog entry builder
 * Outputs Keep a Changelog format (https://keepachangelog.com)
 */

export type ChangeType =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

interface Entry {
  type: ChangeType;
  description: string;
}

interface BreakingChange {
  description: string;
}

export class ChangelogWriter {
  private version: string = "Unreleased";
  private date: string | null = null;
  private entries: Entry[] = [];
  private breakingChanges: BreakingChange[] = [];

  /** Set the version for this changelog block. Example: "1.4.0" */
  setVersion(ver: string): this {
    this.version = ver;
    return this;
  }

  /** Set the release date in ISO format (YYYY-MM-DD). */
  setDate(date: string): this {
    this.date = date;
    return this;
  }

  /** Add a changelog entry under a given Keep a Changelog type. */
  addEntry(type: ChangeType, description: string): this {
    this.entries.push({ type, description });
    return this;
  }

  /**
   * Add a breaking change note. Rendered first under a
   * BREAKING CHANGES section before the typed entries.
   */
  addBreaking(description: string): this {
    this.breakingChanges.push({ description });
    return this;
  }

  /** Render the changelog block as a Keep a Changelog-formatted string. */
  toString(): string {
    const header = this.date
      ? `## [${this.version}] - ${this.date}`
      : `## [${this.version}]`;

    const lines: string[] = [header, ""];

    if (this.breakingChanges.length > 0) {
      lines.push("### BREAKING CHANGES");
      for (const b of this.breakingChanges) {
        lines.push(`- ${b.description}`);
      }
      lines.push("");
    }

    const grouped = this._groupByType();
    const order: ChangeType[] = [
      "Added",
      "Changed",
      "Deprecated",
      "Removed",
      "Fixed",
      "Security",
    ];

    for (const type of order) {
      const items = grouped[type];
      if (!items || items.length === 0) continue;
      lines.push(`### ${type}`);
      for (const item of items) {
        lines.push(`- ${item.description}`);
      }
      lines.push("");
    }

    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines.join("
");
  }

  private _groupByType(): Partial<Record<ChangeType, Entry[]>> {
    const grouped: Partial<Record<ChangeType, Entry[]>> = {};
    for (const entry of this.entries) {
      if (!grouped[entry.type]) grouped[entry.type] = [];
      grouped[entry.type]!.push(entry);
    }
    return grouped;
  }
}
