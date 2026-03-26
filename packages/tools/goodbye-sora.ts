/**
 * Manages disposable resources for graceful shutdown.
 */
export class GoodbyeToSora {
  private disposables: (() => void)[] = [];

  /**
   * Register a disposable function to be called on shutdown.
   * @param dispose Function to dispose of a resource.
   */
  public register(dispose: () => void): void {
    this.disposables.push(dispose);
  }

  /**
   * Trigger all registered disposables.
   */
  public shutdown(): void {
    for (const dispose of this.disposables) {
      dispose();
    }
  }
}