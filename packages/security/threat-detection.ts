/**
 * Threat Detection - middleware for agent input/output analysis.
 *
 * Detects prompt injection, jailbreak patterns, data exfiltration, and SSRF.
 * Runs on every agent turn as middleware.
 */

import { EventEmitter } from 'node:events';

export type ThreatSensitivity = 'low' | 'medium' | 'high';

export interface ThreatResult {
  detected: boolean;
  threats: ThreatMatch[];
  score: number;
  blocked: boolean;
}

interface ThreatMatch {
  category: string;
  pattern: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  matchedText?: string;
}

interface ThreatPattern {
  category: string;
  patterns: RegExp[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  /** Weight for scoring (1-10) */
  weight: number;
}

const THREAT_PATTERNS: ThreatPattern[] = [
  // Prompt injection
  {
    category: 'prompt-injection',
    patterns: [
      /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/i,
      /you\s+are\s+now\s+(?:DAN|evil|unrestricted|jailbroken)/i,
      /new\s+instructions?\s*:?\s*you\s+(must|should|will|can)/i,
      /override\s+(system|safety|security)\s+(prompt|instructions|rules)/i,
      /forget\s+(everything|all|your)\s+(you|instructions|rules)/i,
    ],
    severity: 'high',
    description: 'Prompt injection attempt detected',
    weight: 8,
  },
  // Jailbreak patterns
  {
    category: 'jailbreak',
    patterns: [
      /do\s+anything\s+now/i,
      /developer\s+mode\s+(enabled|activated|on)/i,
      /act\s+as\s+(?:if\s+)?(?:you\s+(?:have|had)\s+)?no\s+(restrictions|limits|boundaries)/i,
      /pretend\s+(?:you\s+(?:are|have)\s+)?(?:no|zero)\s+(?:ethical|moral|safety)/i,
      /hypothetical(?:ly)?\s+(?:speaking|scenario|if)/i,
    ],
    severity: 'high',
    description: 'Jailbreak attempt detected',
    weight: 7,
  },
  // Data exfiltration
  {
    category: 'exfiltration',
    patterns: [
      /send\s+(?:this|the|all|my)\s+(?:data|file|content|info|password|key|token|secret)\s+to/i,
      /upload\s+(?:to|the)\s+(?:pastebin|hastebin|file\.io|transfer\.sh)/i,
      /curl\s+.*\s+-d\s+@/i,
      /wget\s+.*--post-(?:data|file)/i,
      /base64\s+.*\|\s*curl/i,
    ],
    severity: 'critical',
    description: 'Data exfiltration attempt detected',
    weight: 10,
  },
  // SSRF
  {
    category: 'ssrf',
    patterns: [
      /(?:fetch|curl|wget|http\.get)\s*\(?\s*['"]?(?:http:\/\/)?(?:169\.254\.169\.254|metadata\.google|100\.100\.100\.200)/i,
      /(?:fetch|curl|wget)\s*\(?\s*['"]?(?:http:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/(?:admin|internal|private|debug)/i,
      /file:\/\/\//i,
      /gopher:\/\//i,
    ],
    severity: 'critical',
    description: 'SSRF attempt detected',
    weight: 10,
  },
  // Sensitive data patterns in output
  {
    category: 'sensitive-output',
    patterns: [
      /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
      /(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?\S{10,}/i,
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
      /(?:sk|pk|rk)-[a-zA-Z0-9]{20,}/,
    ],
    severity: 'high',
    description: 'Sensitive data in output',
    weight: 8,
  },
  // Dangerous commands
  {
    category: 'dangerous-command',
    patterns: [
      /rm\s+-rf\s+(?:\/|\*|~)/i,
      /sudo\s+chmod\s+777/i,
      /mkfs\s/i,
      /dd\s+if=.*of=\/dev\//i,
      /:\(\)\{\s*:\|:&\s*\};:/,  // Fork bomb
    ],
    severity: 'critical',
    description: 'Dangerous system command detected',
    weight: 10,
  },
  // Social engineering
  {
    category: 'social-engineering',
    patterns: [
      /(?:don't|do\s+not)\s+(?:tell|inform|alert|notify)\s+(?:the\s+)?(?:user|admin|operator)/i,
      /hide\s+(?:this|the)\s+(?:action|command|operation)\s+from/i,
      /(?:secretly|quietly|silently)\s+(?:run|execute|perform|do)/i,
    ],
    severity: 'high',
    description: 'Social engineering attempt detected',
    weight: 7,
  },
];

const SENSITIVITY_THRESHOLDS: Record<ThreatSensitivity, number> = {
  low: 15,
  medium: 8,
  high: 3,
};

export class ThreatDetection extends EventEmitter {
  private sensitivity: ThreatSensitivity;
  private customPatterns: ThreatPattern[] = [];

  constructor(sensitivity: ThreatSensitivity = 'medium') {
    super();
    this.sensitivity = sensitivity;
  }

  /**
   * Analyze text for threats. Use as middleware on agent input/output.
   */
  analyze(text: string): ThreatResult {
    const threats: ThreatMatch[] = [];
    let totalScore = 0;
    const allPatterns = [...THREAT_PATTERNS, ...this.customPatterns];

    for (const threatPattern of allPatterns) {
      for (const regex of threatPattern.patterns) {
        const match = text.match(regex);
        if (match) {
          threats.push({
            category: threatPattern.category,
            pattern: regex.source,
            severity: threatPattern.severity,
            description: threatPattern.description,
            matchedText: match[0].slice(0, 100), // Truncate for logging
          });
          totalScore += threatPattern.weight;
          break; // One match per category is enough
        }
      }
    }

    const threshold = SENSITIVITY_THRESHOLDS[this.sensitivity];
    const blocked = totalScore >= threshold;

    const result: ThreatResult = {
      detected: threats.length > 0,
      threats,
      score: totalScore,
      blocked,
    };

    if (threats.length > 0) {
      this.emit('threat:detected', result);
    }
    if (blocked) {
      this.emit('threat:blocked', result);
    }

    return result;
  }

  /**
   * Middleware function for agent loop integration.
   */
  middleware() {
    return {
      onInput: (input: string): { pass: boolean; result: ThreatResult } => {
        const result = this.analyze(input);
        return { pass: !result.blocked, result };
      },
      onOutput: (output: string): { pass: boolean; result: ThreatResult } => {
        const result = this.analyze(output);
        return { pass: !result.blocked, result };
      },
    };
  }

  setSensitivity(level: ThreatSensitivity): void {
    this.sensitivity = level;
    this.emit('config:sensitivity', { level });
  }

  getSensitivity(): ThreatSensitivity {
    return this.sensitivity;
  }

  addPattern(pattern: ThreatPattern): void {
    this.customPatterns.push(pattern);
  }
}
