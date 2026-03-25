import * as fs from 'fs';
import * as path from 'path';

/**
 * A logger that rotates logs based on size and age.
 */
export class RotatingLogger {
  private readonly baseFilename: string;
  private readonly maxBytes: number;
  private readonly maxDays: number;
  private readonly keepCount: number;
  private currentLogFile: string;

  /**
   * Creates a new RotatingLogger instance.
   * @param options Configuration options
   * @param options.baseFilename Base filename for logs (without extension)
   * @param options.maxBytes Maximum size in bytes before rotation
   * @param options.maxDays Maximum age in days before deletion
   * @param options.keepCount Maximum number of rotated files to keep
   */
  constructor({
    baseFilename,
    maxBytes,
    maxDays,
    keepCount,
  }: {
    baseFilename: string;
    maxBytes: number;
    maxDays: number;
    keepCount: number;
  }) {
    this.baseFilename = baseFilename;
    this.maxBytes = maxBytes;
    this.maxDays = maxDays;
    this.keepCount = keepCount;
    this.currentLogFile = this.createCurrentLogFile();
    this.cleanup();
  }

  /**
   * Writes a log message to the current log file, rotating if necessary.
   * @param data The log message to write
   */
  async write(data: string): Promise<void> {
    try {
      await fs.promises.appendFile(this.currentLogFile, data);
      if (this.getFileSize() >= this.maxBytes) {
        this.rotate();
      }
      this.cleanup();
    } catch (err) {
      console.error('Log write error:', err);
    }
  }

  private createCurrentLogFile(): string {
    return this.baseFilename;
  }

  private getFileSize(): number {
    try {
      const stats = fs.statSync(this.currentLogFile);
      return stats.size;
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    const timestamp = Date.now();
    const oldFile = this.currentLogFile;
    const newFile = `${this.baseFilename}.${timestamp}`;
    try {
      fs.renameSync(oldFile, newFile);
      this.currentLogFile = this.createCurrentLogFile();
    } catch (err) {
      console.error('Log rotation error:', err);
    }
  }

  private cleanup(): void {
    const logDir = path.dirname(this.baseFilename);
    const logFiles = fs.readdirSync(logDir).filter((file) => {
      const filePath = path.join(logDir, file);
      return filePath.startsWith(this.baseFilename) && filePath !== this.currentLogFile;
    });
    const sortedFiles = logFiles.sort((a, b) => {
      const timeA = parseInt(a.split('.')[1], 10);
      const timeB = parseInt(b.split('.')[1], 10);
      return timeA - timeB;
    });
    const now = Date.now();
    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const filePath = path.join(logDir, file);
      const fileTime = parseInt(file.split('.')[1], 10);
      const ageMs = now - fileTime;
      if (ageMs > this.maxDays * 24 * 60 * 60 * 1000) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Log file deletion error:', err);
        }
      }
    }
    if (sortedFiles.length > this.keepCount) {
      for (let i = 0; i < sortedFiles.length - this.keepCount; i++) {
        const file = sortedFiles[i];
        const filePath = path.join(logDir, file);
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.error('Log file deletion error:', err);
        }
      }
    }
  }
}