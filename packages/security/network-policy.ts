/**
 * Network Policy - binary-scoped egress control.
 *
 * YAML-defined egress rules controlling which binaries can reach which hosts.
 * Default: block all outbound except Ollama (localhost:11434).
 * Inspired by NemoClaw's network containment patterns.
 */

import { readFile, watch } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { EventEmitter } from 'node:events';

export interface EgressRule {
  host: string;
  port: number;
  binaries: string[];
  description?: string;
}

interface NetworkPolicyFile {
  egress: EgressRule[];
}

const DEFAULT_EGRESS: EgressRule[] = [
  {
    host: 'localhost',
    port: 11434,
    binaries: ['*'],
    description: 'Ollama local inference',
  },
  {
    host: '127.0.0.1',
    port: 11434,
    binaries: ['*'],
    description: 'Ollama local inference (IPv4)',
  },
];

function normalizeBinaryPath(binary: string): string {
  // Extract binary name from full path
  const parts = binary.split('/');
  return parts[parts.length - 1];
}

function matchesHost(target: string, ruleHost: string): boolean {
  if (ruleHost === '*') return true;

  // Exact match
  if (target === ruleHost) return true;

  // Wildcard subdomain matching (*.example.com)
  if (ruleHost.startsWith('*.')) {
    const domain = ruleHost.slice(2);
    return target === domain || target.endsWith('.' + domain);
  }

  return false;
}

function matchesBinary(binary: string, allowedBinaries: string[]): boolean {
  if (allowedBinaries.includes('*')) return true;

  const normalizedBinary = normalizeBinaryPath(binary);

  for (const allowed of allowedBinaries) {
    const normalizedAllowed = normalizeBinaryPath(allowed);
    if (normalizedBinary === normalizedAllowed) return true;
  }

  return false;
}

export class NetworkPolicy extends EventEmitter {
  private rules: EgressRule[] = [];
  private configPath: string;
  private watching = false;

  constructor(configPath?: string) {
    super();
    this.configPath = configPath ?? join(homedir(), '.8gent', 'policies', 'network.yaml');
    this.rules = [...DEFAULT_EGRESS];
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const parsed = parseYaml(content) as NetworkPolicyFile;

      if (parsed?.egress && Array.isArray(parsed.egress)) {
        // Merge with defaults - user rules take priority
        this.rules = [...DEFAULT_EGRESS, ...parsed.egress];
        this.emit('network:loaded', { ruleCount: this.rules.length });
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.emit('network:defaults', { ruleCount: this.rules.length });
      } else {
        this.emit('network:error', { error: err });
      }
    }
  }

  async startWatching(): Promise<void> {
    if (this.watching) return;
    this.watching = true;

    try {
      const dir = this.configPath.substring(0, this.configPath.lastIndexOf('/'));
      const watcher = watch(dir);
      for await (const event of watcher) {
        if (!this.watching) break;
        const filename = (event as { filename?: string }).filename ?? '';
        if (this.configPath.endsWith(filename)) {
          await this.load();
          this.emit('network:reloaded');
        }
      }
    } catch {
      // Watch failed - that's fine, policy still works without hot-reload
    }
  }

  stopWatching(): void {
    this.watching = false;
  }

  /**
   * Check if a binary is allowed to connect to a host:port.
   */
  checkEgress(
    host: string,
    port: number,
    binary: string,
  ): { allowed: boolean; reason: string; matchedRule?: EgressRule } {
    for (const rule of this.rules) {
      if (matchesHost(host, rule.host) && rule.port === port) {
        if (matchesBinary(binary, rule.binaries)) {
          return {
            allowed: true,
            reason: rule.description ?? `Allowed by egress rule for ${rule.host}:${rule.port}`,
            matchedRule: rule,
          };
        }
        // Host/port match but binary not allowed
        return {
          allowed: false,
          reason: `Binary "${binary}" not authorized for ${host}:${port}`,
          matchedRule: rule,
        };
      }
    }

    // No matching rule - block by default
    const result = {
      allowed: false,
      reason: `No egress rule for ${host}:${port} - blocked by default`,
    };

    this.emit('network:blocked', { host, port, binary, reason: result.reason });
    return result;
  }

  /**
   * Check if a URL is allowed for a given binary.
   */
  checkUrl(url: string, binary: string): { allowed: boolean; reason: string } {
    try {
      const parsed = new URL(url);
      const port = parsed.port
        ? parseInt(parsed.port, 10)
        : parsed.protocol === 'https:' ? 443 : 80;
      return this.checkEgress(parsed.hostname, port, binary);
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }
  }

  getRules(): readonly EgressRule[] {
    return this.rules;
  }

  addRule(rule: EgressRule): void {
    this.rules.push(rule);
    this.emit('network:rule-added', rule);
  }

  removeRule(host: string, port: number): boolean {
    const idx = this.rules.findIndex((r) => r.host === host && r.port === port);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.emit('network:rule-removed', { host, port });
    return true;
  }
}
