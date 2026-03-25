import { existsSync, statSync, renameSync, unlinkSync, createReadStream, createWriteStream } from "fs";
import { appendFileSync, writeFileSync } from "fs";
import { createGzip } from "zlib";
import { pipeline } from "stream/promises";

export interface RotationOptions {
  maxSize?: number;   // bytes, default 10MB
  maxFiles?: number;  // number of rotated files to keep, default 5
  compress?: boolean; // gzip rotated files, default false
}

async function compressFile(src: string, dest: string): Promise<void> {
  const input = createReadStream(src);
  const output = createWriteStream(dest);
  const gzip = createGzip();
  await pipeline(input, gzip, output);
  unlinkSync(src);
}

export async function rotateFile(filePath: string, options: RotationOptions = {}): Promise<void> {
  const { maxFiles = 5, compress = false } = options;
  const ext = compress ? ".gz" : "";

  // Remove oldest file if it exists
  const oldest = `${filePath}.${maxFiles}${ext}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }

  // Shift existing rotated files up by one
  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = `${filePath}.${i}${ext}`;
    const dest = `${filePath}.${i + 1}${ext}`;
    if (existsSync(src)) {
      renameSync(src, dest);
    }
  }

  // Rotate current log to .1
  if (existsSync(filePath)) {
    const dest = `${filePath}.1`;
    renameSync(filePath, dest);
    if (compress) {
      await compressFile(dest, `${dest}.gz`);
    }
  }

  // Create fresh log file
  writeFileSync(filePath, "");
}

export class RotatingLogger {
  private readonly filePath: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private readonly compress: boolean;
  private rotating: boolean = false;

  constructor(filePath: string, options: RotationOptions = {}) {
    this.filePath = filePath;
    this.maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10MB default
    this.maxFiles = options.maxFiles ?? 5;
    this.compress = options.compress ?? false;

    // Ensure the log file exists
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, "");
    }
  }

  async write(line: string): Promise<void> {
    const entry = `${new Date().toISOString()} ${line}\n`;

    // Check if rotation is needed before writing
    if (!this.rotating && this.shouldRotate()) {
      this.rotating = true;
      try {
        await this.rotate();
      } finally {
        this.rotating = false;
      }
    }

    appendFileSync(this.filePath, entry);
  }

  private shouldRotate(): boolean {
    if (!existsSync(this.filePath)) return false;
    const { size } = statSync(this.filePath);
    return size >= this.maxSize;
  }

  private async rotate(): Promise<void> {
    await rotateFile(this.filePath, {
      maxFiles: this.maxFiles,
      compress: this.compress,
    });
  }

  /** Force a rotation regardless of current file size. */
  async forceRotate(): Promise<void> {
    await this.rotate();
  }

  /** Returns the current size of the active log file in bytes. */
  currentSize(): number {
    if (!existsSync(this.filePath)) return 0;
    return statSync(this.filePath).size;
  }

  /** List all log files managed by this logger (active + rotated). */
  listFiles(): string[] {
    const files: string[] = [];
    if (existsSync(this.filePath)) files.push(this.filePath);
    const ext = this.compress ? ".gz" : "";
    for (let i = 1; i <= this.maxFiles; i++) {
      const rotated = `${this.filePath}.${i}${ext}`;
      if (existsSync(rotated)) files.push(rotated);
    }
    return files;
  }
}
