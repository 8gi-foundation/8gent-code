/**
 * Policy Engine - YAML-based deny-by-default policy system.
 *
 * Loads rules from ~/.8gent/policies/, hot-reloads on file change.
 * Inspired by NemoClaw's egress controls and Shannon's approval gates.
 */

import { readdir, readFile, watch } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { EventEmitter } from 'node:events';

export interface PolicyRule {
  action: 'network' | 'filesystem' | 'shell' | 'git';
  allow: string[];
  deny: string[];
  requiresApproval?: boolean;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
}

interface PolicyFile {
  rules: PolicyRule[];
}

const DEFAULT_RULES: PolicyRule[] = [
  {
    action: 'network',
    allow: ['localhost', '127.0.0.1', 'ollama:11434'],
    deny: ['*'],
  },
  {
    action: 'filesystem',
    allow: ['~/.8gent/*', '/tmp/8gent-*'],
    deny: ['/etc/*', '/usr/*', '~/.ssh/*', '~/.gnupg/*'],
  },
  {
    action: 'shell',
    allow: ['git', 'bun', 'node', 'python3', 'ls', 'cat', 'echo'],
    deny: ['rm -rf', 'sudo', 'chmod 777', 'curl | sh', 'wget | sh'],
  },
  {
    action: 'git',
    allow: ['add', 'commit', 'status', 'diff', 'log', 'branch', 'checkout', 'stash'],
    deny: ['push --force', 'reset --hard', 'clean -f'],
    requiresApproval: true,
  },
];

function expandHome(pattern: string): string {
  if (pattern.startsWith('~/') || pattern === '~') {
    return pattern.replace('~', homedir());
  }
  return pattern;
}

function matchesPattern(target: string, pattern: string): boolean {
  if (pattern === '*') return true;

  const expanded = expandHome(pattern);

  // Glob-style matching
  if (expanded.endsWith('/*')) {
    const prefix = expanded.slice(0, -2);
    return target.startsWith(prefix);
  }
  if (expanded.endsWith('*')) {
    const prefix = expanded.slice(0, -1);
    return target.startsWith(prefix);
  }

  // Host:port matching for network rules
  if (pattern.includes(':')) {
    const [host, port] = pattern.split(':');
    return target.includes(host) && target.includes(port);
  }

  // Substring match for shell commands
  return target === expanded || target.startsWith(expanded + ' ') || target.includes(expanded);
}

export class PolicyEngine extends EventEmitter {
  private rules: PolicyRule[] = [];
  private policyDir: string;
  private watcher: AsyncIterable<unknown> | null = null;
  private watching = false;

  constructor(policyDir?: string) {
    super();
    this.policyDir = policyDir ?? join(homedir(), '.8gent', 'policies');
    this.rules = [...DEFAULT_RULES];
  }

  async load(): Promise<void> {
    try {
      const files = await readdir(this.policyDir);
      const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

      const userRules: PolicyRule[] = [];
      for (const file of yamlFiles) {
        const content = await readFile(join(this.policyDir, file), 'utf-8');
        const parsed = parseYaml(content) as PolicyFile;
        if (parsed?.rules && Array.isArray(parsed.rules)) {
          userRules.push(...parsed.rules);
        }
      }

      if (userRules.length > 0) {
        // User rules override defaults for matching actions
        const userActions = new Set(userRules.map((r) => r.action));
        this.rules = [
          ...DEFAULT_RULES.filter((r) => !userActions.has(r.action)),
          ...userRules,
        ];
      }

      this.emit('policy:loaded', { ruleCount: this.rules.length });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No policy dir yet - use defaults
        this.emit('policy:defaults', { ruleCount: this.rules.length });
      } else {
        this.emit('policy:error', { error: err });
      }
    }
  }

  async startWatching(): Promise<void> {
    if (this.watching) return;
    this.watching = true;

    try {
      const watcher = watch(this.policyDir, { recursive: true });
      for await (const event of watcher) {
        if (!this.watching) break;
        const filename = (event as { filename?: string }).filename ?? '';
        if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
          await this.load();
          this.emit('policy:reloaded');
        }
      }
    } catch {
      // Directory doesn't exist or watch failed - that's fine
    }
  }

  stopWatching(): void {
    this.watching = false;
  }

  getRules(): readonly PolicyRule[] {
    return this.rules;
  }

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }
}

export function checkPolicy(
  rules: readonly PolicyRule[],
  action: string,
  target: string,
): PolicyDecision {
  const matchingRules = rules.filter((r) => r.action === action);

  // No rules for this action type - deny by default
  if (matchingRules.length === 0) {
    return {
      allowed: false,
      reason: `No policy rules defined for action "${action}" - denied by default`,
      requiresApproval: true,
    };
  }

  for (const rule of matchingRules) {
    // Check explicit deny first
    for (const pattern of rule.deny) {
      if (pattern !== '*' && matchesPattern(target, pattern)) {
        return {
          allowed: false,
          reason: `Explicitly denied by pattern "${pattern}"`,
          requiresApproval: rule.requiresApproval ?? false,
        };
      }
    }

    // Check explicit allow
    for (const pattern of rule.allow) {
      if (matchesPattern(target, pattern)) {
        return {
          allowed: true,
          reason: `Allowed by pattern "${pattern}"`,
          requiresApproval: false,
        };
      }
    }

    // Check wildcard deny
    if (rule.deny.includes('*')) {
      return {
        allowed: false,
        reason: `Denied by wildcard rule for action "${action}"`,
        requiresApproval: rule.requiresApproval ?? true,
      };
    }
  }

  // Default deny
  return {
    allowed: false,
    reason: 'No matching allow rule - denied by default',
    requiresApproval: true,
  };
}
