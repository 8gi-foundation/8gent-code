/**
 * plugin-loader.ts
 * Dynamic plugin loading with lifecycle management, registration, and
 * dependency-aware init/destroy.
 */

export interface Plugin {
  name: string;
  version: string;
  /** Called once when the plugin is loaded. Must resolve before the plugin is marked active. */
  init(): Promise<void> | void;
  /** Called once when the plugin is unloaded. Must resolve before the plugin is removed. */
  destroy(): Promise<void> | void;
  /** Optional list of capability strings this plugin provides. */
  provides?: string[];
}

interface PluginEntry {
  plugin: Plugin;
  loadedAt: Date;
  active: boolean;
}

export class PluginLoader {
  private registry: Map<string, PluginEntry> = new Map();

  /**
   * Register a plugin definition. Does not load (init) it yet.
   * Throws if a plugin with the same name is already registered.
   */
  register(plugin: Plugin): void {
    if (this.registry.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }
    this.registry.set(plugin.name, {
      plugin,
      loadedAt: new Date(),
      active: false,
    });
  }

  /**
   * Load (init) a previously registered plugin by name.
   * No-op if the plugin is already active.
   */
  async load(name: string): Promise<void> {
    const entry = this.#get(name);
    if (entry.active) return;
    await entry.plugin.init();
    entry.active = true;
  }

  /**
   * Unload (destroy) an active plugin by name.
   * No-op if the plugin is not currently active.
   */
  async unload(name: string): Promise<void> {
    const entry = this.#get(name);
    if (!entry.active) return;
    await entry.plugin.destroy();
    entry.active = false;
  }

  /**
   * Register and immediately load a plugin in one call.
   */
  async registerAndLoad(plugin: Plugin): Promise<void> {
    this.register(plugin);
    await this.load(plugin.name);
  }

  /**
   * Unload and remove a plugin from the registry entirely.
   */
  async unloadAndRemove(name: string): Promise<void> {
    await this.unload(name);
    this.registry.delete(name);
  }

  /**
   * Return the plugin instance by name, or undefined if not registered.
   */
  getPlugin(name: string): Plugin | undefined {
    return this.registry.get(name)?.plugin;
  }

  /**
   * Return the names of all currently active (loaded) plugins.
   */
  listLoaded(): string[] {
    return [...this.registry.entries()]
      .filter(([, e]) => e.active)
      .map(([name]) => name);
  }

  /**
   * Return the names of all registered plugins (loaded or not).
   */
  listRegistered(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Find registered plugins that provide a given capability string.
   */
  findByCapability(capability: string): Plugin[] {
    return [...this.registry.values()]
      .filter((e) => e.plugin.provides?.includes(capability))
      .map((e) => e.plugin);
  }

  /**
   * Unload all active plugins in reverse registration order (LIFO),
   * best-effort - collects errors, throws aggregate at the end.
   */
  async unloadAll(): Promise<void> {
    const names = [...this.registry.keys()].reverse();
    const errors: Error[] = [];
    for (const name of names) {
      const entry = this.registry.get(name)!;
      if (!entry.active) continue;
      try {
        await entry.plugin.destroy();
        entry.active = false;
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `${errors.length} plugin(s) failed to unload cleanly.`);
    }
  }

  // ---- private helpers ------------------------------------------------------

  #get(name: string): PluginEntry {
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`Plugin "${name}" is not registered.`);
    return entry;
  }
}
