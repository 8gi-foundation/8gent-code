/**
 * Animated typing indicator for terminal output.
 * Shows dots, spinner, or braille animation while waiting for model responses.
 * Starts/stops cleanly without leftover characters.
 */

export type IndicatorStyle = "dots" | "spinner" | "braille";

interface TypingIndicatorOptions {
  style?: IndicatorStyle;
  label?: string;
  intervalMs?: number;
  stream?: NodeJS.WriteStream;
}

const FRAMES: Record<IndicatorStyle, string[]> = {
  dots: [".", "..", "...", "   "],
  spinner: ["|", "/", "-", "\\"],
  braille: ["\u2801", "\u2803", "\u2807", "\u280F", "\u281F", "\u283F", "\u287F", "\u28FF",
            "\u28FE", "\u28FC", "\u28F8", "\u28F0", "\u28E0", "\u28C0", "\u2880", "\u2800"],
};

export class TypingIndicator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private lastLength = 0;
  private readonly style: IndicatorStyle;
  private readonly label: string;
  private readonly intervalMs: number;
  private readonly stream: NodeJS.WriteStream;

  constructor(options: TypingIndicatorOptions = {}) {
    this.style = options.style ?? "braille";
    this.label = options.label ?? "Thinking";
    this.intervalMs = options.intervalMs ?? 80;
    this.stream = options.stream ?? process.stderr;
  }

  /** Start the animation. Safe to call if already running (no-op). */
  start(): void {
    if (this.timer) return;
    this.frameIndex = 0;
    this.lastLength = 0;
    this.stream.write("\x1B[?25l"); // hide cursor
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Stop the animation and erase its output. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.clear();
    this.stream.write("\x1B[?25h"); // restore cursor
  }

  /** Whether the indicator is currently animating. */
  get active(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const frames = FRAMES[this.style];
    const frame = frames[this.frameIndex % frames.length];
    const line = `${this.label} ${frame}`;
    this.clear();
    this.stream.write(line);
    this.lastLength = line.length;
    this.frameIndex++;
  }

  private clear(): void {
    if (this.lastLength > 0) {
      this.stream.write(`\r${" ".repeat(this.lastLength)}\r`);
      this.lastLength = 0;
    }
  }
}
