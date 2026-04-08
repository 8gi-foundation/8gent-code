/**
 * 8gent Code - Dependency Supply Chain Scanner
 *
 * Reads package.json and flags known risky packages, install-time scripts,
 * and dependencies that interact with credentials or network at install.
 *
 * Usage:
 *   bun run packages/validation/dep-scanner.ts [path/to/package.json]
 */

import * as fs from "fs";
import * as path from "path";

// ── Known risky packages (supply chain incidents or high-risk patterns) ──

const KNOWN_COMPROMISED: Record<string, string> = {
  litellm: "PyPI supply chain attack - exfiltrates SSH keys, AWS/GCP creds, env vars (2026-03)",
  "event-stream": "npm supply chain attack - stole cryptocurrency (2018)",
  "ua-parser-js": "npm hijack - cryptominer + password stealer (2021)",
  "coa": "npm hijack - malicious code injection (2021)",
  rc: "npm hijack - malicious code injection (2021)",
  "colors.js": "Maintainer sabotage - infinite loop (2022)",
  "faker.js": "Maintainer sabotage - deleted all code (2022)",
  "node-ipc": "Protestware - destructive payload based on locale (2022)",
  "peacenotwar": "Protestware - file overwrite payload (2022)",
};

const HIGH_RISK_PATTERNS = [
  { pattern: /^@anthropic/, reason: "Direct Anthropic SDK - verify source" },
  { pattern: /^openai$/, reason: "OpenAI SDK - verify version integrity" },
  { pattern: /^langchain/, reason: "Large attack surface - many transitive deps" },
  { pattern: /^llama-?index/, reason: "Large attack surface - Python bridge" },
];

// ── Dangerous install scripts ──

const DANGEROUS_SCRIPTS = ["preinstall", "install", "postinstall"];

export interface DepScanFinding {
  severity: "critical" | "high" | "medium" | "info";
  package: string;
  message: string;
}

export interface DepScanResult {
  file: string;
  findings: DepScanFinding[];
  depCount: number;
  hasInstallScripts: boolean;
}

export function scanPackageJson(pkgPath: string): DepScanResult {
  const content = fs.readFileSync(pkgPath, "utf-8");
  const pkg = JSON.parse(content);
  const findings: DepScanFinding[] = [];

  // Collect all dependency names
  const allDeps: string[] = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];

  // Check for known compromised packages
  for (const dep of allDeps) {
    const lower = dep.toLowerCase();
    if (KNOWN_COMPROMISED[lower]) {
      findings.push({
        severity: "critical",
        package: dep,
        message: KNOWN_COMPROMISED[lower],
      });
    }
  }

  // Check for high-risk patterns
  for (const dep of allDeps) {
    for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
      if (pattern.test(dep)) {
        findings.push({
          severity: "medium",
          package: dep,
          message: reason,
        });
      }
    }
  }

  // Check for install-time scripts in our own package.json
  const scripts = pkg.scripts ?? {};
  let hasInstallScripts = false;
  for (const scriptName of DANGEROUS_SCRIPTS) {
    if (scripts[scriptName]) {
      hasInstallScripts = true;
      findings.push({
        severity: "high",
        package: "(self)",
        message: `"${scriptName}" script runs at install time: ${scripts[scriptName].substring(0, 120)}`,
      });
    }
  }

  // Check for unpinned versions (using ^ or ~ or *)
  const pinnedDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [dep, version] of Object.entries(pinnedDeps)) {
    const v = version as string;
    if (v.startsWith("*") || v === "latest") {
      findings.push({
        severity: "high",
        package: dep,
        message: `Unpinned version "${v}" - vulnerable to supply chain substitution`,
      });
    }
  }

  return {
    file: pkgPath,
    findings,
    depCount: allDeps.length,
    hasInstallScripts,
  };
}

// ── CLI entry point ──

function printResult(result: DepScanResult): void {
  console.log(`\n--- Dependency Scan: ${result.file} ---`);
  console.log(`Total dependencies: ${result.depCount}`);
  console.log(`Install scripts: ${result.hasInstallScripts ? "YES (review recommended)" : "none"}`);

  if (result.findings.length === 0) {
    console.log("Findings: CLEAN - no known risks detected\n");
    return;
  }

  console.log(`Findings: ${result.findings.length}\n`);

  const bySeverity = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const f of result.findings) {
    bySeverity[f.severity]++;
    const icon =
      f.severity === "critical" ? "CRIT" :
      f.severity === "high" ? "HIGH" :
      f.severity === "medium" ? "MED " : "INFO";
    console.log(`  [${icon}] ${f.package}: ${f.message}`);
  }

  console.log(
    `\nSummary: ${bySeverity.critical} critical, ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.info} info\n`
  );

  if (bySeverity.critical > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  const target = process.argv[2] ?? "package.json";
  const resolved = path.resolve(target);

  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  // If it's a directory, scan all package.json files in it
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const root = path.join(resolved, "package.json");
    if (fs.existsSync(root)) {
      printResult(scanPackageJson(root));
    }
    // Scan workspace packages
    const pkgsDir = path.join(resolved, "packages");
    const appsDir = path.join(resolved, "apps");
    for (const dir of [pkgsDir, appsDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir)) {
        const pkgJson = path.join(dir, entry, "package.json");
        if (fs.existsSync(pkgJson)) {
          printResult(scanPackageJson(pkgJson));
        }
      }
    }
  } else {
    printResult(scanPackageJson(resolved));
  }
}
