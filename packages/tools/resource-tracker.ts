/**
 * ResourceTracker - tracks allocated resources for cleanup on exit.
 *
 * Features:
 * - track(resource, cleanup): register a resource with a cleanup function
 * - untrack(resource): remove a resource from tracking without running cleanup
 * - disposeAll(): run all cleanup functions and clear the registry
 * - onDispose(fn): register a global teardown hook
 * - Nested scopes via tracker.scope()
 * - Auto-cleanup on process exit (SIGINT, SIGTERM, uncaughtException)
 */

type CleanupFn = () => void | Promise<void>;

interface TrackedResource {
  resource: unknown;
  cleanup: CleanupFn;
  label?: string;
}

export class ResourceTracker {
  private resources: TrackedResource[] = [];
  private disposeHooks: CleanupFn[] = [];
  private disposed = false;
  private exitRegistered = false;

  constructor(private autoExit = true) {
    if (autoExit) {
      this._registerExitHandlers();
    }
  }

  /**
   * Register a resource with an associated cleanup function.
   * Returns the resource for chaining.
   */
  track<T>(resource: T, cleanup: CleanupFn, label?: string): T {
    if (this.disposed) {
      throw new Error("ResourceTracker: cannot track after disposal");
    }
    this.resources.push({ resource, cleanup, label });
    return resource;
  }

  /**
   * Remove a resource from tracking without running its cleanup.
   */
  untrack(resource: unknown): void {
    const idx = this.resources.findIndex((r) => r.resource === resource);
    if (idx !== -1) {
      this.resources.splice(idx, 1);
    }
  }

  /**
   * Register a hook to run when disposeAll() is called.
   * Runs after all tracked resource cleanups.
   */
  onDispose(fn: CleanupFn): void {
    this.disposeHooks.push(fn);
  }

  /**
   * Run all cleanup functions in reverse registration order,
   * then run all onDispose hooks. Idempotent.
   */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Cleanup in LIFO order (most recently acquired, first released)
    const toClean = [...this.resources].reverse();
    this.resources = [];

    for (const { cleanup, label } of toClean) {
      try {
        await cleanup();
      } catch (err) {
        const tag = label ? ` [${label}]` : "";
        console.error(`ResourceTracker: cleanup failed${tag}:`, err);
      }
    }

    for (const hook of this.disposeHooks) {
      try {
        await hook();
      } catch (err) {
        console.error("ResourceTracker: onDispose hook failed:", err);
      }
    }
    this.disposeHooks = [];
  }

  /**
   * Create a nested child scope. Disposing the child does not affect the parent.
   * Child does NOT auto-register exit handlers - parent handles that.
   */
  scope(): ResourceTracker {
    const child = new ResourceTracker(false);
    // Register child disposal as a tracked resource on this parent
    this.track(child, () => child.disposeAll(), "nested-scope");
    return child;
  }

  /** Count of currently tracked resources. */
  get size(): number {
    return this.resources.length;
  }

  private _registerExitHandlers(): void {
    if (this.exitRegistered) return;
    this.exitRegistered = true;

    const handler = async (signal?: string) => {
      if (signal) process.stderr.write(`\nResourceTracker: caught ${signal}, disposing...\n`);
      await this.disposeAll();
    };

    process.once("exit", () => { void this.disposeAll(); });
    process.once("SIGINT", () => handler("SIGINT").then(() => process.exit(0)));
    process.once("SIGTERM", () => handler("SIGTERM").then(() => process.exit(0)));
    process.once("uncaughtException", (err) => {
      console.error("ResourceTracker: uncaughtException:", err);
      handler("uncaughtException").then(() => process.exit(1));
    });
  }
}

/** Module-level singleton tracker for convenience. */
export const globalTracker = new ResourceTracker(true);
