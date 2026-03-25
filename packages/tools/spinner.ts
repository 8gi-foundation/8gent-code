/**
 * Terminal spinner/progress indicator with multiple styles,
 * success/fail states, and timed auto-stop.
 *
 * Usage:
 *   const s = new Spinner({ style: 'braille', text: 'Loading...' });
 *   s.start();
 *   // ... work ...
 *   s.succeed('Done');
 */

type SpinnerStyle = 'dots' | 'bars' | 'braille' | 'arrows';

interface SpinnerOptions {
  style?: SpinnerStyle;
  text?: string;
  /** Auto-stop after this many ms (0 = no auto-stop) */
  timeout?: number;
  /** Stream to write to (default: process.stderr) */
  stream?: NodeJS.WriteStream;
}

const FRAMES: Record<SpinnerStyle, string[]> = {
  dots: ['.  ', '.. ', '...', ' ..', '  .', '   '],
  bars: ['|', '/', '-', '\\'],
  braille: ['\u2807', '\u2836', '\u2834', '\u2826', '\u2816', '\u280E', '\u280B', '\u2839'],
  arrows: ['\u2190', '\u2196', '\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199'],
};

const INTERVAL_MS = 80;

export class Spinner {
  private style: SpinnerStyle;
  private text: string;
  private stream: NodeJS.WriteStream;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;

  constructor(opts: SpinnerOptions = {}) {
    this.style = opts.style ?? 'braille';
    this.text = opts.text ?? '';
    this.stream = opts.stream ?? process.stderr;
  }

  start(text?: string): this {
    if (text) this.text = text;
    if (this.timer) return this;
    this.frame = 0;
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
    this.render();
    return this;
  }

  stop(): this {
    if (this.timer) clearInterval(this.timer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timer = null;
    this.timeoutTimer = null;
    this.clearLine();
    return this;
  }

  /** Auto-stop after `ms` milliseconds, resolving the returned promise. */
  autoStop(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timeoutTimer = setTimeout(() => {
        this.stop();
        resolve();
      }, ms);
    });
  }

  succeed(text?: string): void {
    this.stop();
    this.stream.write(`\x1B[32m\u2714\x1B[0m ${text ?? this.text}\n`);
  }

  fail(text?: string): void {
    this.stop();
    this.stream.write(`\x1B[31m\u2718\x1B[0m ${text ?? this.text}\n`);
  }

  /** Update the spinner text while running. */
  update(text: string): void {
    this.text = text;
  }

  get isSpinning(): boolean {
    return this.timer !== null;
  }

  private render(): void {
    const frames = FRAMES[this.style];
    const char = frames[this.frame % frames.length];
    this.frame++;
    this.clearLine();
    this.stream.write(`\x1B[36m${char}\x1B[0m ${this.text}`);
  }

  private clearLine(): void {
    this.stream.write('\r\x1B[K');
  }
}
