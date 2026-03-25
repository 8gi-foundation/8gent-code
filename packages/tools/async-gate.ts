/**
 * AsyncGate - open/close gate that blocks or allows async operations.
 *
 * AsyncGate: manually controlled gate (open/close/toggle/wait)
 * AutoCloseGate: gate that auto-closes after N passes
 */

type Resolver = () => void;

export class AsyncGate {
  private _open: boolean;
  private _waiters: Resolver[] = [];

  constructor(initiallyOpen = false) {
    this._open = initiallyOpen;
  }

  get isOpen(): boolean {
    return this._open;
  }

  /**
   * Open the gate. All pending waiters are released immediately.
   */
  open(): void {
    if (this._open) return;
    this._open = true;
    this._flush();
  }

  /**
   * Close the gate. Subsequent wait() calls will block until open() is called.
   */
  close(): void {
    this._open = false;
  }

  /**
   * Toggle the gate state.
   */
  toggle(): void {
    if (this._open) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Wait until the gate is open.
   * Resolves immediately if already open.
   */
  wait(): Promise<void> {
    if (this._open) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  private _flush(): void {
    const pending = this._waiters.splice(0);
    for (const resolve of pending) {
      resolve();
    }
  }
}

/**
 * AutoCloseGate - gate that auto-closes after a given number of passes.
 *
 * Useful for rate-limiting or single-shot unlock patterns:
 *   const gate = new AutoCloseGate(3); // allows 3 passes then closes
 *   gate.open();
 *   await gate.wait(); // pass 1
 *   await gate.wait(); // pass 2
 *   await gate.wait(); // pass 3 - gate closes automatically after this
 *   await gate.wait(); // blocks until opened again
 */
export class AutoCloseGate extends AsyncGate {
  private _passesAllowed: number;
  private _passesTaken = 0;

  constructor(passesPerOpen: number) {
    super(false);
    if (passesPerOpen < 1) {
      throw new Error("AutoCloseGate passesPerOpen must be >= 1");
    }
    this._passesAllowed = passesPerOpen;
  }

  /**
   * Open the gate and reset the pass counter.
   */
  override open(): void {
    this._passesTaken = 0;
    super.open();
  }

  /**
   * Wait for the gate. Counts each pass; closes automatically after passesPerOpen passes.
   */
  override async wait(): Promise<void> {
    await super.wait();
    this._passesTaken++;
    if (this._passesTaken >= this._passesAllowed) {
      this.close();
    }
  }

  get passesRemaining(): number {
    return Math.max(0, this._passesAllowed - this._passesTaken);
  }
}
