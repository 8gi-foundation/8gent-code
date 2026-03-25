/**
 * ServiceRegistry - register and discover services by name and version.
 * Provides heartbeat tracking and health status for registered services.
 */

export interface ServiceMetadata {
  version: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface ServiceEntry {
  name: string;
  url: string;
  metadata: ServiceMetadata;
  registeredAt: number;
  lastHeartbeat: number;
  healthy: boolean;
}

const HEARTBEAT_TTL_MS = 30_000;

export class ServiceRegistry {
  private services = new Map<string, ServiceEntry[]>();

  /**
   * Register a service. Multiple instances of the same name can coexist with
   * different versions or URLs.
   */
  register(name: string, url: string, metadata: ServiceMetadata): ServiceEntry {
    const entry: ServiceEntry = {
      name,
      url,
      metadata,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      healthy: true,
    };

    const existing = this.services.get(name) ?? [];
    // Replace if same url already registered
    const idx = existing.findIndex((e) => e.url === url);
    if (idx !== -1) {
      existing[idx] = entry;
    } else {
      existing.push(entry);
    }
    this.services.set(name, existing);
    return entry;
  }

  /**
   * Discover a service by name, optionally filtering by exact version.
   * Returns the first healthy instance that matches.
   */
  discover(name: string, version?: string): ServiceEntry | undefined {
    this.pruneStale();
    const entries = this.services.get(name) ?? [];
    return entries.find((e) => {
      if (!e.healthy) return false;
      if (version !== undefined && e.metadata.version !== version) return false;
      return true;
    });
  }

  /**
   * Record a heartbeat for all instances of a service name, or a specific URL.
   */
  heartbeat(name: string, url?: string): boolean {
    const entries = this.services.get(name);
    if (!entries || entries.length === 0) return false;

    let updated = false;
    for (const entry of entries) {
      if (url === undefined || entry.url === url) {
        entry.lastHeartbeat = Date.now();
        entry.healthy = true;
        updated = true;
      }
    }
    return updated;
  }

  /**
   * Deregister a service by name and optional URL.
   * If no URL given, removes all instances of that name.
   */
  deregister(name: string, url?: string): boolean {
    if (!this.services.has(name)) return false;

    if (url === undefined) {
      this.services.delete(name);
      return true;
    }

    const entries = this.services.get(name)!;
    const filtered = entries.filter((e) => e.url !== url);
    if (filtered.length === entries.length) return false;
    if (filtered.length === 0) {
      this.services.delete(name);
    } else {
      this.services.set(name, filtered);
    }
    return true;
  }

  /**
   * List every registered service entry (all names, all instances).
   */
  listAll(): ServiceEntry[] {
    this.pruneStale();
    return Array.from(this.services.values()).flat();
  }

  /**
   * Returns a health summary: total registered, healthy count, stale count.
   */
  health(): { total: number; healthy: number; stale: number } {
    const all = Array.from(this.services.values()).flat();
    const now = Date.now();
    const stale = all.filter((e) => now - e.lastHeartbeat > HEARTBEAT_TTL_MS);
    const healthy = all.filter((e) => e.healthy && now - e.lastHeartbeat <= HEARTBEAT_TTL_MS);
    return { total: all.length, healthy: healthy.length, stale: stale.length };
  }

  // Mark stale entries unhealthy and remove them
  private pruneStale(): void {
    const now = Date.now();
    for (const [name, entries] of this.services.entries()) {
      const live = entries.filter((e) => {
        if (now - e.lastHeartbeat > HEARTBEAT_TTL_MS) {
          e.healthy = false;
          return false;
        }
        return true;
      });
      if (live.length === 0) {
        this.services.delete(name);
      } else {
        this.services.set(name, live);
      }
    }
  }
}
