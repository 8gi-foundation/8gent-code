/**
 * Scans text for API keys/secrets using predefined patterns.
 * @param text - Source code text to scan
 * @returns Object with found secrets and cleaned text
 */
export function scan(text: string): { found: SecretHit[], clean: string } {
  const lines = text.split('\n');
  const found: SecretHit[] = [];
  const patterns = getPatterns();
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      const matches = line.matchAll(pattern.regex);
      for (const match of matches) {
        found.push({ type: pattern.type, value: match[0], line: i + 1 });
      }
    }
  }
  
  return { found, clean: redact(text) };
}

/**
 * Scans file content with filename context.
 * @param content - File content to scan
 * @param filename - Filename for context
 * @returns Object with found secrets and cleaned content
 */
export function scanFile(content: string, filename: string): { found: SecretHit[], clean: string } {
  const { found, clean } = scan(content);
  return { found: found.map(h => ({ ...h, filename })), clean };
}

/**
 * Redacts detected secrets in text.
 * @param text - Text to redact
 * @returns Text with secrets replaced by REDACTED
 */
export function redact(text: string): string {
  const patterns = getPatterns();
  let result = text;
  
  for (const pattern of patterns) {
    result = result.replace(pattern.regex, 'REDACTED');
  }
  
  return result;
}

/**
 * Renders detection report as table.
 * @param results - Scan results to render
 */
export function renderReport(results: { found: SecretHit[], clean: string }): void {
  console.table(results.found.map(h => ({
    Type: h.type,
    Value: h.value,
    Line: h.line,
    Severity: getSeverity(h.type)
  })));
}

interface SecretHit {
  type: string;
  value: string;
  line: number;
  filename?: string;
}

function getPatterns(): { type: string, regex: RegExp }[] {
  return [
    { type: 'AWS', regex: /[A-Z0-9]{20}/g },
    { type: 'OpenAI', regex: /sk-[a-zA-Z0-9]{24}/g },
    { type: 'Stripe', regex: /sk_live_[a-zA-Z0-9]{24}/g },
    { type: 'GitHub', regex: /ghp_[a-zA-Z0-9]{36}/g },
    { type: 'Slack', regex: /xox[baprs]-[a-zA-Z0-9]{12,}/g },
    { type: 'Twilio', regex: /[A-F0-9]{32}/g },
    { type: 'GCP', regex: /AIza[0-9A-Za-z-_]{35}/g }
  ];
}

function getSeverity(type: string): string {
  switch (type) {
    case 'AWS': return 'High';
    case 'GCP': return 'High';
    default: return 'Medium';
  }
}