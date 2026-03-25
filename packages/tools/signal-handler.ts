/**
 * signal-handler.ts
 * Graceful process signal handling with ordered cleanup callbacks and configurable timeout.
 * Handles SIGINT, SIGTERM, SIGHUP. Prevents double-exit.
 */

type CleanupFn = () => void | Promise<void>;

interface ShutdownOptions {
  /** Max ms to wait for all cleanup callbacks before force-exiting. Default: 5000 */
  timeoutMs?: number;
  /** Exit code on graceful shutdown. Default: 0 */
  exitCode?: number;
}

export class SignalHandler {
  private callbacks: CleanupFn[] = [];
  private isShuttingDown = false;
  private timeoutMs: number;
  private exitCode: number;

  constructor(options: ShutdownOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.exitCode = options.exitCode ?? 0;
    this.register();
  }

  /** Register a cleanup callback. Callbacks run in registration order. */
  onShutdown(fn: CleanupFn): void {
    this.callbacks.push(fn);
  }

  private register(): void {
    const handler = (signal: string) => this.handleSignal(signal);
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    process.on("SIGHUP", handler);
  }

  private async handleSignal(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    process.stderr.write(`\n[signal-handler] Received ${signal}. Starting graceful shutdown...\n`);

    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        process.stderr.write(`[signal-handler] Cleanup timed out after ${this.timeoutMs}ms. Force exiting.\n`);
        resolve();
      }, this.timeoutMs)
    );

    const cleanup = this.runCallbacks();

    await Promise.race([cleanup, timeout]);
    process.exit(this.exitCode);
  }

  private async runCallbacks(): Promise<void> {
    for (const fn of this.callbacks) {
      try {
        await fn();
      } catch (err) {
        process.stderr.write(`[signal-handler] Cleanup callback error: ${err}\n`);
      }
    }
    process.stderr.write(`[signal-handler] Cleanup complete.\n`);
  }

  /** Manually trigger shutdown (e.g. on uncaught error). */
  async shutdown(signal = "MANUAL"): Promise<void> {
    await this.handleSignal(signal);
  }
}

// Module-level singleton for simple usage
let _handler: SignalHandler | null = null;

function getHandler(): SignalHandler {
  if (!_handler) _handler = new SignalHandler();
  return _handler;
}

/**
 * Register a cleanup callback on the module-level singleton handler.
 * Callbacks run in registration order on SIGINT/SIGTERM/SIGHUP.
 *
 * @example
 * onShutdown(async () => { await db.close(); });
 */
export function onShutdown(fn: CleanupFn): void {
  getHandler().onShutdown(fn);
}

/**
 * Configure the module-level singleton (call before any onShutdown registrations).
 */
export function configureSignalHandler(options: ShutdownOptions): SignalHandler {
  _handler = new SignalHandler(options);
  return _handler;
}
