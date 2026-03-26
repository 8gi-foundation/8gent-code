/**
 * TLS audit result interface.
 */
interface AuditResult {
  weakCiphers: string[];
  oldProtocols: string[];
  hstsMaxAge: number | null;
  ocspStapling: boolean;
  score: number;
  grade: string;
}

/**
 * Flags weak ciphers in the provided list.
 * @param ciphers - List of cipher suite names.
 * @returns Array of weak cipher names found.
 */
export function flagWeakCiphers(ciphers: string[]): string[] {
  const weak = ['RC4', 'DES', '3DES', 'EXPORT'];
  return ciphers.filter(c => weak.some(w => c.includes(w)));
}

/**
 * Flags outdated TLS protocols.
 * @param protocols - List of protocol versions.
 * @returns Array of outdated protocol names found.
 */
export function flagOldProtocols(protocols: string[]): string[] {
  const old = ['TLS 1.0', 'TLS 1.1', 'SSL 2.0', 'SSL 3.0'];
  return protocols.filter(p => old.some(o => p.includes(o)));
}

/**
 * Calculates a TLS quality score (0-100) based on audit results.
 * @param audit - Audit result object.
 * @returns Score between 0 and 100.
 */
export function score(audit: AuditResult): number {
  let s = 100;
  if (audit.weakCiphers.length > 0) s -= audit.weakCiphers.length * 10;
  if (audit.oldProtocols.length > 0) s -= audit.oldProtocols.length * 20;
  if (audit.hstsMaxAge !== null && audit.hstsMaxAge < 30) s -= 10;
  if (!audit.ocspStapling) s -= 5;
  return Math.max(0, s);
}

/**
 * Audits TLS configuration parameters.
 * @param params - Configuration parameters to audit.
 * @returns Audit result object.
 */
export function auditConfig(params: {
  protocols: string[];
  ciphers: string[];
  hstsMaxAge: number | null;
  ocspStapling: boolean;
}): AuditResult {
  const weakCiphers = flagWeakCiphers(params.ciphers);
  const oldProtocols = flagOldProtocols(params.protocols);
  const s = score({ ...params, weakCiphers, oldProtocols });
  const grade = s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : 'F';
  return { weakCiphers, oldProtocols, ...params, score: s, grade };
}

/**
 * Generates a markdown report from audit results.
 * @param audit - Audit result object.
 * @returns Markdown-formatted TLS audit report.
 */
export function renderReport(audit: AuditResult): string {
  let report = `# TLS Audit Report\n\n**Grade**: ${audit.grade} (${audit.score}/100)\n\n## Issues\n`;
  if (audit.weakCiphers.length > 0) {
    report += '### Weak Ciphers\n- ' + audit.weakCiphers.join('\n- ') + '\n';
  }
  if (audit.oldProtocols.length > 0) {
    report += '### Outdated Protocols\n- ' + audit.oldProtocols.join('\n- ') + '\n';
  }
  if (audit.hstsMaxAge !== null && audit.hstsMaxAge < 30) {
    report += `- HSTS max-age too low: ${audit.hstsMaxAge} (recommended: ≥30 days)\n`;
  }
  if (!audit.ocspStapling) {
    report += `- OCSP stapling not enabled\n`;
  }
  return report;
}