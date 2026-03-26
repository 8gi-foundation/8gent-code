/**
 * Collects diagnostic information and errors.
 */
export class Diagnostic {
  private entries: { [key: string]: any } = {};
  private errors: { message: string; stack?: string; name?: string }[] = [];

  /**
   * Adds a key-value pair to the diagnostic.
   * @param key The key.
   * @param value The value.
   */
  add(key: string, value: any): void {
    this.entries[key] = value;
  }

  /**
   * Adds an error to the diagnostic.
   * @param err The error.
   */
  addError(err: Error): void {
    this.errors.push(Diagnostic.fromError(err));
  }

  /**
   * Extracts standard error fields.
   * @param err The error.
   * @returns An object with error details.
   */
  static fromError(err: Error): { message: string; stack?: string; name?: string } {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }

  /**
   * Returns structured diagnostic data.
   * @returns An object with entries and errors.
   */
  toReport(): { entries: { [key: string]: any }; errors: { message: string; stack?: string; name?: string }[] } {
    return { entries: this.entries, errors: this.errors };
  }

  /**
   * Returns a human-readable diagnostic string.
   * @returns A multi-line string.
   */
  toText(): string {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(this.entries)) {
      lines.push(`${key}: ${value}`);
    }
    for (const error of this.errors) {
      lines.push(`Error: ${error.message}`);
      if (error.stack) lines.push(`Stack: ${error.stack}`);
      if (error.name) lines.push(`Name: ${error.name}`);
    }
    return lines.join('\n');
  }
}