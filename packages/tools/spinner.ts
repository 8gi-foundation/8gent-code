/**
 * Terminal spinner with multiple animation styles.
 */
export class Spinner {
  private intervalId: NodeJS.Timeout | null = null;
  private startTime: number | null = null;
  private frames: string[];
  private currentFrame: number = 0;
  private text: string = '';
  private isRunning: boolean = false;

  /**
   * Creates a new Spinner instance with the specified animation style.
   * @param style - The animation style ('dots', 'line', 'arc', 'bounce')
   */
  constructor(private style: 'dots' | 'line' | 'arc' | 'bounce') {
    this.frames = this.getFrames();
  }

  private getFrames(): string[] {
    switch (this.style) {
      case 'dots':
        return ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠧', '⠇', '⠏'];
      case 'line':
        return ['|', '/', '—', '\\'];
      case 'arc':
        return ['◜', '◠', '◝', '◞', '◡', '◟'];
      case 'bounce':
        return ['-', '\\', '|', '/'];
      default:
        return ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠧', '⠇', '⠏'];
    }
  }

  /**
   * Starts the spinner with the given text.
   * @param text - The text to display alongside the spinner.
   */
  start(text: string): void {
    this.text = text;
    this.startTime = performance.now();
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      if (!this.isRunning) return;
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      process.stdout.write(`\r${this.frames[this.currentFrame]} ${this.text}`);
    }, 100);
  }

  /**
   * Stops the spinner and returns the elapsed time in milliseconds.
   * @returns Elapsed time in milliseconds.
   */
  stop(): number {
    if (!this.isRunning) return 0;
    this.isRunning = false;
    clearInterval(this.intervalId!);
    const elapsedTime = performance.now() - this.startTime!;
    process.stdout.write('\n');
    return elapsedTime;
  }

  /**
   * Stops the spinner and displays a success message.
   * @param text - The success message to display.
   */
  succeed(text: string): void {
    this.stop();
    process.stdout.write(`✅ ${text}\n`);
  }

  /**
   * Stops the spinner and displays a failure message.
   * @param text - The failure message to display.
   */
  fail(text: string): void {
    this.stop();
    process.stdout.write(`❌ ${text}\n`);
  }

  /**
   * Updates the text displayed alongside the spinner.
   * @param newText - The new text to display.
   */
  updateText(newText: string): void {
    this.text = newText;
  }
}