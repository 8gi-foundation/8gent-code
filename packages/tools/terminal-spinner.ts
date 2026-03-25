/**
 * terminal-spinner.ts
 * Animated terminal spinners with status text for CLI feedback.
 *
 * Usage:
 *   const s = createSpinner({ style: "dots" });
 *   s.start("Thinking...");
 *   s.succeed("Done.");
 */

export type SpinnerStyle = "dots" | "line" | "arc" | "bouncingBall";

const STYLES: Record<SpinnerStyle, { frames: string[]; interval: number }> = {
  dots: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    interval: 80,
  },
  line: {
    frames: ["-", "\\", "|", "/"],
    interval: 120,
  },
  arc: {
    frames: ["◜", "◠", "◝", "◞", "◡", "◟"],
    interval: 100,
  },
  bouncingBall: {
    frames: [
      "( ●    )",
      "(  ●   )",
      "(   ●  )",
      "(    ● )",
      "(     ●)",
      "(    ● )",
      "(   ●  )",
      "(  ●   )",
      "( ●    )",
      "(●     )",
    ],
    interval: 80,
  },
};

export interface SpinnerOptions {
  style?: SpinnerStyle;
  stream?: NodeJS.WriteStream;
}

export class Spinner {
  private style: SpinnerStyle;
  private stream: NodeJS.WriteStream;
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private text = "";
  private running = false;

  constructor(options: SpinnerOptions = {}) {
    this.style = options.style ?? "dots";
    this.stream = options.stream ?? process.stderr;
  }

  /** Start spinning with optional status text. */
  start(text = ""): this {
    if (this.running) this.stop();
    this.text = text;
    this.running = true;
    this.frameIndex = 0;

    const { frames, interval } = STYLES[this.style];

    this.timer = setInterval(() => {
      const frame = frames[this.frameIndex % frames.length];
      this._write(`\r${frame} ${this.text}`);
      this.frameIndex++;
    }, interval);

    return this;
  }

  /** Update status text without restarting the spinner. */
  update(text: string): this {
    this.text = text;
    return this;
  }

  /** Stop and clear the spinner line. */
  stop(symbol = ""): this {
    if (!this.running) return this;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this._write("\r\x1b[K"); // carriage return + erase line
    if (symbol) {
      this._writeln(`${symbol} ${this.text}`);
    }

    return this;
  }

  /** Stop with a success symbol. */
  succeed(text?: string): this {
    if (text) this.text = text;
    return this.stop("\x1b[32m✔\x1b[0m");
  }

  /** Stop with a failure symbol. */
  fail(text?: string): this {
    if (text) this.text = text;
    return this.stop("\x1b[31m✖\x1b[0m");
  }

  /** Stop with a warning symbol. */
  warn(text?: string): this {
    if (text) this.text = text;
    return this.stop("\x1b[33m⚠\x1b[0m");
  }

  /** Stop with an info symbol. */
  info(text?: string): this {
    if (text) this.text = text;
    return this.stop("\x1b[36mℹ\x1b[0m");
  }

  private _write(str: string): void {
    this.stream.write(str);
  }

  private _writeln(str: string): void {
    this.stream.write(`${str}\n`);
  }
}

/** Convenience factory. */
export function createSpinner(options: SpinnerOptions = {}): Spinner {
  return new Spinner(options);
}
