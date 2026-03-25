/**
 * Terminal progress bar with ETA, speed, multi-bar support, and color transitions.
 * Zero dependencies. Works in any Node/Bun terminal.
 *
 * @example
 *   const bar = new ProgressBar({ total: 100, label: 'Downloading' });
 *   bar.update(50);
 *   bar.finish();
 *
 *   const multi = new MultiProgress();
 *   const a = multi.add({ total: 200, label: 'Task A' });
 *   const b = multi.add({ total: 100, label: 'Task B' });
 *   a.update(80);
 *   b.update(60);
 */

// ---------------------------------------------------------------------------
// ANSI helpers (zero deps)
// ---------------------------------------------------------------------------

const ESC = '\x1b[';

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  clearLine: '\r\x1b[2K',
  up: (n: number) => `${ESC}${n}A`,
  color: {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    white: '\x1b[37m',
  },
};

function colorize(text: string, color: keyof typeof ansi.color): string {
  return `${ansi.color[color]}${text}${ansi.reset}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressBarOptions {
  /** Total number of units. Required. */
  total: number;
  /** Display label. */
  label?: string;
  /** Bar width in chars. Default: 30. */
  width?: number;
  /** Filled portion char. Default: block element. */
  filledChar?: string;
  /** Empty portion char. Default: light shade. */
  emptyChar?: string;
  /** Show ETA. Default: true. */
  showEta?: boolean;
  /** Show speed. Default: true. */
  showSpeed?: boolean;
  /** Show percentage. Default: true. */
  showPercent?: boolean;
  /** Unit label for speed. Default: 'it'. */
  unit?: string;
  /** Output stream. Default: process.stderr. */
  stream?: NodeJS.WriteStream;
}

export interface ProgressSnapshot {
  current: number;
  total: number;
  percent: number;
  elapsed: number;
  eta: number | null;
  speed: number;
  done: boolean;
}

// ---------------------------------------------------------------------------
// Color transition: green (0-60%) -> yellow (60-80%) -> red (80-100%)
// ---------------------------------------------------------------------------

function barColor(percent: number): keyof typeof ansi.color {
  if (percent >= 80) return 'red';
  if (percent >= 60) return 'yellow';
  return 'green';
}

// ---------------------------------------------------------------------------
// Human-readable formatters
// ---------------------------------------------------------------------------

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtSpeed(speed: number, unit: string): string {
  if (speed >= 1_000_000) return `${(speed / 1_000_000).toFixed(1)}M${unit}/s`;
  if (speed >= 1_000) return `${(speed / 1_000).toFixed(1)}k${unit}/s`;
  return `${speed.toFixed(1)}${unit}/s`;
}

// ---------------------------------------------------------------------------
// Moving average for stable speed/ETA estimates
// ---------------------------------------------------------------------------

class MovingAverage {
  private samples: number[] = [];
  private maxSamples: number;

  constructor(maxSamples = 10) {
    this.maxSamples = maxSamples;
  }

  push(value: number): void {
    this.samples.push(value);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get avg(): number {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }
}

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export class ProgressBar {
  private current = 0;
  private total: number;
  private label: string;
  private width: number;
  private filledChar: string;
  private emptyChar: string;
  private showEta: boolean;
  private showSpeed: boolean;
  private showPercent: boolean;
  private unit: string;
  private stream: NodeJS.WriteStream;

  private startTime: number;
  private lastTime: number;
  private lastCurrent: number;
  private speedMa: MovingAverage;
  private _done = false;

  constructor(options: ProgressBarOptions) {
    this.total = Math.max(1, options.total);
    this.label = options.label ?? '';
    this.width = options.width ?? 30;
    this.filledChar = options.filledChar ?? '\u2588';
    this.emptyChar = options.emptyChar ?? '\u2591';
    this.showEta = options.showEta ?? true;
    this.showSpeed = options.showSpeed ?? true;
    this.showPercent = options.showPercent ?? true;
    this.unit = options.unit ?? 'it';
    this.stream = options.stream ?? process.stderr;

    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.lastCurrent = 0;
    this.speedMa = new MovingAverage(10);
  }

  /** Update current value and re-render. */
  update(value: number): void {
    if (this._done) return;
    const now = Date.now();
    const delta = value - this.lastCurrent;
    const dt = (now - this.lastTime) / 1000;

    if (dt > 0 && delta >= 0) {
      this.speedMa.push(delta / dt);
    }

    this.current = Math.min(value, this.total);
    this.lastCurrent = this.current;
    this.lastTime = now;

    this.render();

    if (this.current >= this.total) {
      this.finish();
    }
  }

  /** Increment by delta (default 1). */
  increment(delta = 1): void {
    this.update(this.current + delta);
  }

  /** Complete the bar and print a newline. */
  finish(): void {
    if (this._done) return;
    this._done = true;
    this.current = this.total;
    this.render();
    this.stream.write('\n');
  }

  /** Get current snapshot without rendering. */
  snapshot(): ProgressSnapshot {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const percent = (this.current / this.total) * 100;
    const speed = this.speedMa.avg;
    const remaining = this.total - this.current;
    const eta = speed > 0 ? remaining / speed : null;
    return { current: this.current, total: this.total, percent, elapsed, eta, speed, done: this._done };
  }

  /** Render the bar in place. Returns the formatted line. */
  render(clearLine = true): string {
    const snap = this.snapshot();
    const line = this.format(snap);
    if (clearLine) {
      this.stream.write(ansi.clearLine + line);
    }
    return line;
  }

  /** Format a snapshot into a printable string without writing. */
  format(snap: ProgressSnapshot): string {
    const pct = Math.min(100, snap.percent);
    const filled = Math.round((pct / 100) * this.width);
    const empty = this.width - filled;

    const bar =
      colorize(this.filledChar.repeat(filled), barColor(pct)) +
      ansi.dim + this.emptyChar.repeat(empty) + ansi.reset;

    const parts: string[] = [];

    if (this.label) {
      parts.push(ansi.bold + this.label + ansi.reset);
    }

    parts.push(`[${bar}]`);

    if (this.showPercent) {
      parts.push(colorize(`${pct.toFixed(1)}%`, barColor(pct)));
    }

    parts.push(`${snap.current}/${snap.total}`);

    if (this.showSpeed) {
      parts.push(ansi.dim + fmtSpeed(snap.speed, this.unit) + ansi.reset);
    }

    if (this.showEta && snap.eta !== null) {
      const label = snap.done ? 'done' : `ETA ${fmtTime(snap.eta)}`;
      parts.push(ansi.dim + label + ansi.reset);
    }

    return parts.join(' ');
  }

  get done(): boolean {
    return this._done;
  }
}

// ---------------------------------------------------------------------------
// MultiProgress - manages N bars in a fixed terminal region
// ---------------------------------------------------------------------------

export interface MultiProgressOptions {
  /** Stream to write to. Default: process.stderr. */
  stream?: NodeJS.WriteStream;
  /** Refresh interval in ms. Default: 100. */
  interval?: number;
}

export class MultiProgress {
  private bars: ProgressBar[] = [];
  private stream: NodeJS.WriteStream;
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lineCount = 0;
  private started = false;

  constructor(options: MultiProgressOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.interval = options.interval ?? 100;
  }

  /** Add a new bar. Returns the bar handle for updating. */
  add(options: Omit<ProgressBarOptions, 'stream'>): ProgressBar {
    const bar = new ProgressBar({ ...options, stream: this.stream });
    this.bars.push(bar);
    if (!this.started) this.start();
    return bar;
  }

  /** Render all bars in place, overwriting previous output. */
  render(): void {
    if (this.lineCount > 0) {
      this.stream.write(ansi.up(this.lineCount));
    }
    this.lineCount = 0;
    for (const bar of this.bars) {
      const line = bar.format(bar.snapshot());
      this.stream.write(ansi.clearLine + line + '\n');
      this.lineCount++;
    }
  }

  /** Stop the auto-refresh timer and do a final render. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.render();
  }

  /** True when every bar is finished. */
  get allDone(): boolean {
    return this.bars.length > 0 && this.bars.every((b) => b.done);
  }

  private start(): void {
    this.started = true;
    // Reserve vertical space for all bars
    for (let i = 0; i < this.bars.length; i++) {
      this.stream.write('\n');
    }
    this.lineCount = this.bars.length;

    this.timer = setInterval(() => {
      this.render();
      if (this.allDone) this.stop();
    }, this.interval);
  }
}
