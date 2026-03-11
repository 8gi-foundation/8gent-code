/**
 * 8gent Code - Security Scanner
 *
 * Trust no one. Not even ourselves.
 *
 * Scans skill files for dangerous patterns before allowing installation.
 */

import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Types
// ============================================================================

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Verdict = "PASS" | "FAIL" | "REVIEW_REQUIRED";

export interface Finding {
  severity: Severity;
  category: string;
  file: string;
  line: number;
  pattern: string;
  context: string;
  recommendation: string;
}

export interface ScanResult {
  scanTimestamp: string;
  skillPath: string;
  skillName: string;
  verdict: Verdict;
  findings: Finding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    totalFilesScanned: number;
  };
  scanDurationMs: number;
}

interface PatternRule {
  pattern: RegExp;
  severity: Severity;
  category: string;
  recommendation: string;
}

// ============================================================================
// Security Rules
// ============================================================================

const SECURITY_RULES: PatternRule[] = [
  // CRITICAL: Command Injection
  {
    pattern: /\$\([^)]+\)/g,
    severity: "CRITICAL",
    category: "Command Injection",
    recommendation: "Remove command substitution - can execute arbitrary code"
  },
  {
    pattern: /`[^`]+`/g,
    severity: "CRITICAL",
    category: "Command Injection",
    recommendation: "Remove backtick execution - potential code injection"
  },
  {
    pattern: /\beval\s*\(/g,
    severity: "CRITICAL",
    category: "Code Execution",
    recommendation: "Never use eval() - replace with safe alternatives"
  },
  {
    pattern: /\bexec\s*\(/g,
    severity: "CRITICAL",
    category: "Command Execution",
    recommendation: "exec() runs arbitrary commands - requires justification"
  },
  {
    pattern: /child_process/g,
    severity: "CRITICAL",
    category: "Process Spawning",
    recommendation: "child_process enables shell execution - review carefully"
  },
  {
    pattern: /\bspawn\s*\(|spawnSync\s*\(/g,
    severity: "CRITICAL",
    category: "Process Spawning",
    recommendation: "spawn() executes arbitrary binaries - requires review"
  },
  {
    pattern: /execSync/g,
    severity: "CRITICAL",
    category: "Synchronous Execution",
    recommendation: "Sync process execution - high risk for command injection"
  },
  {
    pattern: /Bun\.spawn|Bun\.spawnSync/g,
    severity: "CRITICAL",
    category: "Bun Process Spawning",
    recommendation: "Bun.spawn executes binaries - requires review"
  },

  // CRITICAL: Data Exfiltration
  {
    pattern: /curl\s+.*(-d|--data|--data-raw|--data-binary)/gi,
    severity: "CRITICAL",
    category: "Data Exfiltration",
    recommendation: "curl with POST - verify no sensitive data sent"
  },
  {
    pattern: /wget\s+.*--post/gi,
    severity: "CRITICAL",
    category: "Data Exfiltration",
    recommendation: "wget POST - verify no sensitive data sent"
  },

  // HIGH: Credential Access
  {
    pattern: /process\.env\[?['"`]?(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/gi,
    severity: "HIGH",
    category: "Credential Access",
    recommendation: "Accessing sensitive env vars - verify necessity"
  },
  {
    pattern: /\.env\b/g,
    severity: "HIGH",
    category: "Credential Access",
    recommendation: ".env file reference - may contain secrets"
  },
  {
    pattern: /dotenv|loadEnv/g,
    severity: "HIGH",
    category: "Credential Access",
    recommendation: "Env loader detected - review what's loaded"
  },
  {
    pattern: /credentials?\.json/gi,
    severity: "HIGH",
    category: "Credential Access",
    recommendation: "Credentials file reference - high sensitivity"
  },
  {
    pattern: /api[_-]?key\s*[:=]/gi,
    severity: "HIGH",
    category: "Hardcoded Credential",
    recommendation: "Possible hardcoded API key - remove immediately"
  },
  {
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: "CRITICAL",
    category: "Private Key Exposure",
    recommendation: "Private key detected - NEVER commit private keys"
  },

  // HIGH: System Modification
  {
    pattern: /chmod\s+[0-7]{3,4}/g,
    severity: "HIGH",
    category: "Permission Change",
    recommendation: "chmod changes file permissions - verify intent"
  },
  {
    pattern: /chown\s+/g,
    severity: "HIGH",
    category: "Ownership Change",
    recommendation: "chown changes ownership - verify intent"
  },
  {
    pattern: /rm\s+(-rf?|--recursive)\s+/g,
    severity: "HIGH",
    category: "Destructive Operation",
    recommendation: "Recursive delete - verify target is safe"
  },
  {
    pattern: /\/(etc|usr|var|root)\/(?!local)/g,
    severity: "HIGH",
    category: "System Path Access",
    recommendation: "Accessing system paths - verify intentional"
  },
  {
    pattern: /sudo\s+/g,
    severity: "CRITICAL",
    category: "Privilege Escalation",
    recommendation: "sudo detected - high risk operation"
  },

  // MEDIUM: Network Calls
  {
    pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|github\.com|npmjs\.com)[^\s"'`<>]+/g,
    severity: "MEDIUM",
    category: "External Network Call",
    recommendation: "External URL - verify trusted endpoint"
  },
  {
    pattern: /\bfetch\s*\(/g,
    severity: "MEDIUM",
    category: "Network Request",
    recommendation: "fetch() call - verify destination"
  },
  {
    pattern: /axios|got|node-fetch|request\(/g,
    severity: "MEDIUM",
    category: "HTTP Library",
    recommendation: "HTTP client - review all network calls"
  },
  {
    pattern: /WebSocket|ws:\/\//g,
    severity: "MEDIUM",
    category: "WebSocket",
    recommendation: "WebSocket connection - verify destination"
  },

  // MEDIUM: Code Obfuscation
  {
    pattern: /atob\s*\(|btoa\s*\(/g,
    severity: "MEDIUM",
    category: "Base64 Encoding",
    recommendation: "Base64 ops - may hide malicious content"
  },
  {
    pattern: /Buffer\.from\s*\([^,]+,\s*['"]base64['"]\)/g,
    severity: "MEDIUM",
    category: "Base64 Decoding",
    recommendation: "Base64 buffer - inspect decoded content"
  },
  {
    pattern: /\\x[0-9a-fA-F]{2}/g,
    severity: "MEDIUM",
    category: "Hex Encoding",
    recommendation: "Hex-encoded chars - potential obfuscation"
  },
  {
    pattern: /String\.fromCharCode/g,
    severity: "MEDIUM",
    category: "Character Encoding",
    recommendation: "fromCharCode often hides strings - review"
  },
  {
    pattern: /[A-Za-z0-9+/=]{100,}/g,
    severity: "MEDIUM",
    category: "Long Encoded String",
    recommendation: "Long base64-like string - may be encoded payload"
  },

  // MEDIUM: Dynamic Execution
  {
    pattern: /new\s+Function\s*\(/g,
    severity: "MEDIUM",
    category: "Dynamic Function",
    recommendation: "Function constructor is like eval() - avoid"
  },
  {
    pattern: /import\s*\([^)]+\)/g,
    severity: "MEDIUM",
    category: "Dynamic Import",
    recommendation: "Dynamic import - verify imported module"
  },
  {
    pattern: /require\s*\([^'"][^)]+\)/g,
    severity: "MEDIUM",
    category: "Dynamic Require",
    recommendation: "Dynamic require - potential injection"
  },

  // LOW: Potentially Suspicious
  {
    pattern: /setTimeout|setInterval/g,
    severity: "LOW",
    category: "Timed Execution",
    recommendation: "Timer functions - review delayed code"
  },
  {
    pattern: /fs\.(read|write|append|unlink|rm)/g,
    severity: "LOW",
    category: "File Operations",
    recommendation: "File system ops - verify paths are safe"
  },
  {
    pattern: /crypto\.createHash|crypto\.randomBytes/g,
    severity: "LOW",
    category: "Cryptography",
    recommendation: "Crypto operations - verify purpose"
  },
  {
    pattern: /\bhidden\s*[:=]\s*true/g,
    severity: "LOW",
    category: "Hidden Element",
    recommendation: "Hidden flag - may hide malicious behavior"
  },
];

// ============================================================================
// File Extensions to Scan
// ============================================================================

const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx",
  ".md", ".yaml", ".yml", ".json",
  ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go", ".rs"
]);

// ============================================================================
// Scanner Implementation
// ============================================================================

async function getAllFiles(dir: string, files: string[] = []): Promise<string[]> {
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip hidden and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    if (entry.isDirectory()) {
      await getAllFiles(fullPath, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SCANNABLE_EXTENSIONS.has(ext) || entry.name === "Dockerfile") {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function scanFile(filePath: string, rules: PatternRule[]): Finding[] {
  const findings: Finding[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (const rule of rules) {
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Clone regex for each line
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(line)) !== null) {
        // Get context (2 lines before and after)
        const contextStart = Math.max(0, lineNum - 2);
        const contextEnd = Math.min(lines.length - 1, lineNum + 2);
        const context = lines.slice(contextStart, contextEnd + 1).join("\n");

        findings.push({
          severity: rule.severity,
          category: rule.category,
          file: filePath,
          line: lineNum + 1,
          pattern: match[0].substring(0, 100),
          context: context.substring(0, 500),
          recommendation: rule.recommendation
        });

        // Prevent infinite loops
        if (match.index === regex.lastIndex) {
          regex.lastIndex++;
        }
      }
    }
  }

  return findings;
}

function determineVerdict(summary: ScanResult["summary"]): Verdict {
  if (summary.critical > 0) return "FAIL";
  if (summary.high >= 3) return "FAIL";
  if (summary.high > 0 || summary.medium >= 5) return "REVIEW_REQUIRED";
  return "PASS";
}

// ============================================================================
// Main Export
// ============================================================================

export async function scanSkill(skillPath: string): Promise<ScanResult> {
  const startTime = Date.now();
  const skillName = path.basename(skillPath);

  // Get all scannable files
  const files = await getAllFiles(skillPath);

  // Scan all files
  const allFindings: Finding[] = [];
  for (const file of files) {
    const findings = scanFile(file, SECURITY_RULES);
    allFindings.push(...findings);
  }

  // Deduplicate
  const seen = new Set<string>();
  const uniqueFindings = allFindings.filter(f => {
    const key = `${f.file}:${f.line}:${f.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by severity
  const severityOrder: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  uniqueFindings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Calculate summary
  const summary = {
    critical: uniqueFindings.filter(f => f.severity === "CRITICAL").length,
    high: uniqueFindings.filter(f => f.severity === "HIGH").length,
    medium: uniqueFindings.filter(f => f.severity === "MEDIUM").length,
    low: uniqueFindings.filter(f => f.severity === "LOW").length,
    totalFilesScanned: files.length
  };

  return {
    scanTimestamp: new Date().toISOString(),
    skillPath,
    skillName,
    verdict: determineVerdict(summary),
    findings: uniqueFindings,
    summary,
    scanDurationMs: Date.now() - startTime
  };
}

// ============================================================================
// Human-Readable Format
// ============================================================================

export function formatScanResult(result: ScanResult): string {
  const verdictEmoji: Record<Verdict, string> = {
    PASS: "✅",
    FAIL: "🚫",
    REVIEW_REQUIRED: "⚠️"
  };

  let output = `
🔍 SECURITY SCAN: ${result.skillName}
${"━".repeat(50)}

📊 Verdict: ${verdictEmoji[result.verdict]} ${result.verdict}

`;

  if (result.summary.critical > 0) {
    output += `🚨 CRITICAL (${result.summary.critical})\n`;
    for (const f of result.findings.filter(f => f.severity === "CRITICAL")) {
      const relPath = f.file.replace(result.skillPath, ".");
      output += `  └─ ${relPath}:${f.line}\n`;
      output += `     Pattern: ${f.pattern}\n`;
      output += `     → ${f.recommendation}\n\n`;
    }
  }

  if (result.summary.high > 0) {
    output += `⚠️  HIGH (${result.summary.high})\n`;
    for (const f of result.findings.filter(f => f.severity === "HIGH")) {
      const relPath = f.file.replace(result.skillPath, ".");
      output += `  └─ ${relPath}:${f.line} - ${f.category}\n`;
    }
    output += "\n";
  }

  if (result.summary.medium > 0) {
    output += `📝 MEDIUM (${result.summary.medium})\n`;
    for (const f of result.findings.filter(f => f.severity === "MEDIUM").slice(0, 5)) {
      const relPath = f.file.replace(result.skillPath, ".");
      output += `  └─ ${relPath}:${f.line} - ${f.category}\n`;
    }
    if (result.summary.medium > 5) {
      output += `  └─ ... and ${result.summary.medium - 5} more\n`;
    }
    output += "\n";
  }

  if (result.findings.length === 0) {
    output += `✨ No security issues detected!\n\n`;
  }

  output += `${"─".repeat(50)}
📁 Files scanned: ${result.summary.totalFilesScanned}
⏱️  Duration: ${result.scanDurationMs}ms
`;

  return output;
}
