/**
 * A lazily evaluated value that defers computation until first access.
 * @template T The type of the value.
 */
export class LazyValue<T> {
  private _value: T | undefined;
  private _initialized: boolean = false;
  private readonly factory: () => T;

  /**
   * Creates a new LazyValue instance.
   * @param factory The factory function to compute the value.
   */
  constructor(factory: () => T) {
    this.factory = factory;
  }

  /**
   * Gets the computed value, initializing it if necessary.
   * @returns The computed value.
   */
  get value(): T {
    if (!this._initialized) {
      this._value = this.factory();
      this._initialized = true;
    }
    return this._value!;
  }

  /**
   * Checks if the value has been initialized.
   * @returns True if initialized, false otherwise.
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Resets the cached value, forcing re-evaluation on next access.
   */
  reset(): void {
    this._value = undefined;
    this._initialized = false;
  }
}