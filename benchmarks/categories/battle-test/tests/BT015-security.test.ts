import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let scanner: any, vulnerability: any, report: any;

beforeEach(async () => {
  try {
    scanner = await import(path.join(WORK_DIR, "scanner.ts"));
    vulnerability = await import(path.join(WORK_DIR, "vulnerability.ts"));
    report = await import(path.join(WORK_DIR, "report.ts"));
  } catch {}
});

describe("Scanner — scanDependencies", () => {
  it("flags wildcard version dependencies", () => {
    const scanDependencies = scanner.scanDependencies || scanner.default?.scanDependencies;
    const result = scanDependencies({
      dependencies: { "some-lib": "*", "safe-lib": "^2.0.0" },
    });
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    expect(result.riskyPackages).toContain("some-lib");
  });

  it("flags 'latest' version as risky", () => {
    const scanDependencies = scanner.scanDependencies || scanner.default?.scanDependencies;
    const result = scanDependencies({
      dependencies: { "my-pkg": "latest" },
    });
    expect(result.riskyPackages).toContain("my-pkg");
  });

  it("returns clean result for safe dependencies", () => {
    const scanDependencies = scanner.scanDependencies || scanner.default?.scanDependencies;
    const result = scanDependencies({
      dependencies: { "react": "^18.2.0", "typescript": "^5.0.0" },
    });
    expect(result.riskyPackages.length).toBe(0);
  });

  it("scans both dependencies and devDependencies", () => {
    const scanDependencies = scanner.scanDependencies || scanner.default?.scanDependencies;
    const result = scanDependencies({
      dependencies: { "safe": "^1.0.0" },
      devDependencies: { "risky": "*" },
    });
    expect(result.scannedCount).toBe(2);
    expect(result.riskyPackages).toContain("risky");
  });
});

describe("Scanner — scanCode", () => {
  it("detects eval usage as critical", () => {
    const scanCode = scanner.scanCode || scanner.default?.scanCode;
    const result = scanCode(`const x = eval("alert(1)");`);
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    const evalVuln = result.vulnerabilities.find((v: any) => v.category === "injection");
    expect(evalVuln).toBeDefined();
    expect(evalVuln.severity).toBe("critical");
  });

  it("detects innerHTML as XSS risk", () => {
    const scanCode = scanner.scanCode || scanner.default?.scanCode;
    const result = scanCode(`element.innerHTML = userInput;`);
    const xssVuln = result.vulnerabilities.find((v: any) => v.category === "xss");
    expect(xssVuln).toBeDefined();
  });

  it("detects hardcoded secrets", () => {
    const scanCode = scanner.scanCode || scanner.default?.scanCode;
    const result = scanCode(`const password = "hunter2";\nconst apiKey = "sk-abc123";`);
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
  });

  it("returns clean result for safe code", () => {
    const scanCode = scanner.scanCode || scanner.default?.scanCode;
    const result = scanCode(`function add(a: number, b: number) { return a + b; }`);
    expect(result.vulnerabilities.length).toBe(0);
  });

  it("includes line numbers in patterns", () => {
    const scanCode = scanner.scanCode || scanner.default?.scanCode;
    const code = `const x = 1;\nconst y = eval("bad");\nconst z = 3;`;
    const result = scanCode(code);
    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.patterns[0]).toHaveProperty("line");
    expect(result.patterns[0].line).toBe(2);
  });
});

describe("Scanner — scanConfig", () => {
  it("flags debug mode as medium severity", () => {
    const scanConfig = scanner.scanConfig || scanner.default?.scanConfig;
    const result = scanConfig({ debug: true, port: 3000 });
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    const debugVuln = result.vulnerabilities.find((v: any) => v.title?.toLowerCase().includes("debug") || v.description?.toLowerCase().includes("debug"));
    expect(debugVuln).toBeDefined();
  });

  it("flags open CORS as high severity", () => {
    const scanConfig = scanner.scanConfig || scanner.default?.scanConfig;
    const result = scanConfig({ cors: "*" });
    const corsVuln = result.vulnerabilities.find((v: any) => v.severity === "high");
    expect(corsVuln).toBeDefined();
  });

  it("flags weak crypto algorithms", () => {
    const scanConfig = scanner.scanConfig || scanner.default?.scanConfig;
    const result = scanConfig({ crypto: { algorithm: "md5" } });
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
  });

  it("returns clean result for secure config", () => {
    const scanConfig = scanner.scanConfig || scanner.default?.scanConfig;
    const result = scanConfig({ port: 443, tls: true });
    expect(result.vulnerabilities.length).toBe(0);
  });
});

describe("Vulnerability utilities", () => {
  it("calculateRiskScore weights by severity", () => {
    const calculateRiskScore = vulnerability.calculateRiskScore || vulnerability.default?.calculateRiskScore;
    const vulns = [
      { id: "1", title: "t", severity: "critical", category: "injection", description: "", remediation: "" },
      { id: "2", title: "t", severity: "low", category: "config", description: "", remediation: "" },
    ];
    const score = calculateRiskScore(vulns);
    expect(score).toBeGreaterThanOrEqual(11); // 10 + 1
    expect(score).toBeLessThanOrEqual(100);
  });

  it("calculateRiskScore caps at 100", () => {
    const calculateRiskScore = vulnerability.calculateRiskScore || vulnerability.default?.calculateRiskScore;
    const vulns = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), title: "t", severity: "critical" as const, category: "injection" as const, description: "", remediation: "",
    }));
    const score = calculateRiskScore(vulns);
    expect(score).toBe(100);
  });

  it("groupBySeverity groups correctly", () => {
    const groupBySeverity = vulnerability.groupBySeverity || vulnerability.default?.groupBySeverity;
    const vulns = [
      { id: "1", severity: "critical", title: "", category: "injection", description: "", remediation: "" },
      { id: "2", severity: "critical", title: "", category: "xss", description: "", remediation: "" },
      { id: "3", severity: "low", title: "", category: "config", description: "", remediation: "" },
    ];
    const grouped = groupBySeverity(vulns);
    expect(grouped.critical.length).toBe(2);
    expect(grouped.low.length).toBe(1);
  });

  it("getRemediationPriority sorts critical injection first", () => {
    const getRemediationPriority = vulnerability.getRemediationPriority || vulnerability.default?.getRemediationPriority;
    const vulns = [
      { id: "1", severity: "low", category: "config", title: "", description: "", remediation: "" },
      { id: "2", severity: "critical", category: "injection", title: "", description: "", remediation: "" },
      { id: "3", severity: "high", category: "xss", title: "", description: "", remediation: "" },
    ];
    const sorted = getRemediationPriority(vulns);
    expect(sorted[0].id).toBe("2");
    expect(sorted[1].severity).toBe("high");
  });
});

describe("Report", () => {
  it("generateSecurityReport assigns correct grade", () => {
    const generateSecurityReport = report.generateSecurityReport || report.default?.generateSecurityReport;
    const result = generateSecurityReport({
      code: {
        vulnerabilities: [
          { id: "1", title: "Eval", severity: "critical", category: "injection", description: "", remediation: "Remove eval" },
        ],
        linesScanned: 100,
        patterns: [],
      },
    });
    expect(result).toHaveProperty("grade");
    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("findings");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("generatedAt");
    expect(["A", "B", "C", "D", "F"]).toContain(result.grade);
  });

  it("grade A for no vulnerabilities", () => {
    const generateSecurityReport = report.generateSecurityReport || report.default?.generateSecurityReport;
    const result = generateSecurityReport({
      code: { vulnerabilities: [], linesScanned: 50, patterns: [] },
      deps: { vulnerabilities: [], scannedCount: 10, riskyPackages: [] },
      config: { vulnerabilities: [], checksPerformed: 5, issues: [] },
    });
    expect(result.grade).toBe("A");
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("toMarkdown includes Security Audit Report header", () => {
    const generateSecurityReport = report.generateSecurityReport || report.default?.generateSecurityReport;
    const toMarkdown = report.toMarkdown || report.default?.toMarkdown;
    const secReport = generateSecurityReport({
      code: { vulnerabilities: [], linesScanned: 10, patterns: [] },
    });
    const md = toMarkdown(secReport);
    expect(md).toContain("# Security Audit Report");
  });

  it("toJSON returns valid JSON string", () => {
    const generateSecurityReport = report.generateSecurityReport || report.default?.generateSecurityReport;
    const toJSON = report.toJSON || report.default?.toJSON;
    const secReport = generateSecurityReport({
      code: { vulnerabilities: [], linesScanned: 10, patterns: [] },
    });
    const json = toJSON(secReport);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveProperty("grade");
    expect(parsed).toHaveProperty("findings");
  });
});
