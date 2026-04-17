/**
 * Terminal progress bar with percentage, ETA, speed, and custom format strings.
 * Supports multiple concurrent bars.
 */

export interface ProgressBarOptions {
  total: number;
  width?: number;
  format?: string;
  fillChar?: string;
  emptyChar?: string;
  stream?: { write(s: string): void; isTTY?: boolean };
}

interface BarState {
  current: number;
  total: number;
  startTime: number;
  width: number;
  format: string;
  fillChar: string;
  emptyChar: string;
  line: number;
  done: boolean;
}

const DEFAULT_FORMAT = '[:bar] :percent | :speed/s | ETA :eta | :current/:total';
const DEFAULT_WIDTH = 30;

export class ProgressBar {
  private bars: Map<string, BarState> = new Map();
  private stream: { write(s: string): void; isTTY?: boolean };
  private nextLine = 0;

  constructor(stream?: { write(s: string): void; isTTY?: boolean }) {
    this.stream = stream ?? process.stderr;
  }

  create(id: string, opts: ProgressBarOptions): void {
    if (this.bars.has(id)) return;
    this.bars.set(id, {
      current: 0,
      total: opts.total,
      startTime: Date.now(),
      width: opts.width ?? DEFAULT_WIDTH,
      format: opts.format ?? DEFAULT_FORMAT,
      fillChar: opts.fillChar ?? '#',
      emptyChar: opts.emptyChar ?? '-',
      line: this.nextLine++,
      done: false,
    });
    this.render(id);
  }

  update(id: string, current: number): void {
    const bar = this.bars.get(id);
    if (!bar || bar.done) return;
    bar.current = Math.min(current, bar.total);
    if (bar.current >= bar.total) bar.done = true;
    this.render(id);
  }

  increment(id: string, delta = 1): void {
    const bar = this.bars.get(id);
    if (!bar) return;
    this.update(id, bar.current + delta);
  }

  private render(id: string): void {
    const bar = this.bars.get(id);
    if (!bar) return;

    const ratio = bar.total > 0 ? bar.current / bar.total : 0;
    const filled = Math.round(bar.width * ratio);
    const barStr =
      bar.fillChar.repeat(filled) + bar.emptyChar.repeat(bar.width - filled);

    const elapsed = (Date.now() - bar.startTime) / 1000;
    const speed = elapsed > 0 ? bar.current / elapsed : 0;
    const remaining = speed > 0 ? (bar.total - bar.current) / speed : 0;

    const line = bar.format
      .replace(':bar', barStr)
      .replace(':percent', `${(ratio * 100).toFixed(1)}%`)
      .replace(':eta', formatTime(remaining))
      .replace(':elapsed', formatTime(elapsed))
      .replace(':speed', speed.toFixed(1))
      .replace(':current', String(bar.current))
      .replace(':total', String(bar.total))
      .replace(':id', id);

    const totalBars = this.bars.size;
    const offset = totalBars - 1 - bar.line;
    if (this.stream.isTTY) {
      const up = offset > 0 ? `\x1b[${offset}A` : '';
      const down = offset > 0 ? `\x1b[${offset}B` : '';
      this.stream.write(`${up}\r\x1b[K${line}${down}`);
    } else {
      this.stream.write(`${line}\n`);
    }
  }

  remove(id: string): void {
    this.bars.delete(id);
  }

  get active(): number {
    return [...this.bars.values()].filter((b) => !b.done).length;
  }
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
