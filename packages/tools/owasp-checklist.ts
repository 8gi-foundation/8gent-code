/**
 * Represents a single item in the OWASP Top 10 compliance checklist.
 */
interface ChecklistItem {
  id: number;
  description: string;
  risk: string;
  remediation: string;
  status: 'pass' | 'fail' | 'na' | 'todo';
}

/**
 * Generates the OWASP Top 10 compliance checklist with default status 'todo'.
 * @returns Array of checklist items.
 */
function getChecklist(): ChecklistItem[] {
  return [
    { id: 1, description: 'Injection', risk: 'High', remediation: 'Use parameterized queries', status: 'todo' },
    { id: 2, description: 'Broken Authentication', risk: 'High', remediation: 'Implement multi-factor authentication', status: 'todo' },
    { id: 3, description: 'Sensitive Data Exposure', risk: 'High', remediation: 'Encrypt sensitive data', status: 'todo' },
    { id: 4, description: 'XML External Entities', risk: 'Medium', remediation: 'Disable XXE processing', status: 'todo' },
    { id: 5, description: 'Broken Access Control', risk: 'High', remediation: 'Implement least privilege', status: 'todo' },
    { id: 6, description: 'Security Misconfiguration', risk: 'Medium', remediation: 'Automate configuration checks', status: 'todo' },
    { id: 7, description: 'Cross-Site Scripting', risk: 'High', remediation: 'Sanitize user input', status: 'todo' },
    { id: 8, description: 'Insecure Deserialization', risk: 'High', remediation: 'Validate deserialized data', status: 'todo' },
    { id: 9, description: 'Using Components with Known Vulnerabilities', risk: 'High', remediation: 'Update dependencies regularly', status: 'todo' },
    { id: 10, description: 'Insufficient Logging & Monitoring', risk: 'Medium', remediation: 'Implement centralized logging', status: 'todo' },
  ];
}

/**
 * Updates the status of a checklist item.
 * @param checklist The checklist array.
 * @param id The item ID.
 * @param status The new status ('pass', 'fail', 'na', 'todo').
 * @returns Updated checklist.
 */
function markItem(checklist: ChecklistItem[], id: number, status: 'pass' | 'fail' | 'na' | 'todo'): ChecklistItem[] {
  return checklist.map(item => item.id === id ? { ...item, status } : item);
}

/**
 * Calculates the compliance score as a percentage of non-NA items that are passing.
 * @param checklist The checklist array.
 * @returns Compliance score (0-100).
 */
function complianceScore(checklist: ChecklistItem[]): number {
  const total = checklist.filter(item => item.status !== 'na').length;
  const passed = checklist.filter(item => item.status === 'pass').length;
  return total === 0 ? 0 : (passed / total) * 100;
}

/**
 * Renders the checklist as markdown with status icons and remediations.
 * @param checklist The checklist array.
 * @returns Markdown-formatted report.
 */
function renderReport(checklist: ChecklistItem[]): string {
  let md = '# OWASP Top 10 Compliance Report\n\n';
  md += `**Compliance Score:** ${complianceScore(checklist).toFixed(1)}%\n\n`;
  md += '## Checklist\n\n';
  checklist.forEach(item => {
    const icon = item.status === 'pass' ? '✅' : item.status === 'fail' ? '❌' : item.status === 'na' ? '-' : '⚠️';
    md += `- ${icon} **${item.id}. ${item.description}** (Risk: ${item.risk})\n`;
    md += `  Remediation: ${item.remediation}\n`;
    md += `  Status: ${item.status}\n\n`;
  });
  return md;
}

/**
 * Exports the checklist as a JSON string.
 * @param checklist The checklist array.
 * @returns JSON string.
 */
function exportJSON(checklist: ChecklistItem[]): string {
  return JSON.stringify(checklist, null, 2);
}

export { ChecklistItem, getChecklist, markItem, complianceScore, renderReport, exportJSON };