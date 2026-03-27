/**
 * Newsletter issue builder utility
 */
export interface Issue {
  number: number;
  date: string;
  subject: string;
  previewText: string;
  sections: Section[];
}

export interface Section {
  type: 'intro' | 'featured' | 'cta';
  title: string;
  content: string;
  cta?: { text: string; url: string };
}

/**
 * Creates a new newsletter issue
 * @param config - Issue configuration
 * @returns New issue object
 */
export function createIssue(config: { number: number; date: string; subject: string; previewText: string }): Issue {
  return { ...config, sections: [] };
}

/**
 * Adds a section to an issue
 * @param issue - Target issue
 * @param config - Section configuration
 */
export function addSection(issue: Issue, config: Omit<Section, 'type'>): void {
  issue.sections.push({ ...config, type: config.cta ? 'cta' : 'featured' });
}

/**
 * Renders issue as plain text
 * @param issue - Newsletter issue
 * @returns Formatted text
 */
export function renderText(issue: Issue): string {
  return [
    `${issue.subject}\n`,
    `${issue.previewText}\n`,
    ...issue.sections.map(s => 
      `${s.title}\n${s.content}\n${s.cta ? `🔗 ${s.cta.text} ${s.cta.url}` : ''}\n`
    )
  ].join('\n');
}

/**
 * Renders issue as HTML
 * @param issue - Newsletter issue
 * @returns Formatted HTML
 */
export function renderHTML(issue: Issue): string {
  return `<html><body style="font-family:sans-serif">
    <h1>${issue.subject}</h1>
    <p>${issue.previewText}</p>
    ${issue.sections.map(s => `
      <h2>${s.title}</h2>
      <p>${s.content}</p>
      ${s.cta ? `<a style="color:#0066cc" href="${s.cta.url}">${s.cta.text}</a>` : ''}
    `).join('')}
  </body></html>`;
}

/**
 * Calculates total word count
 * @param issue - Newsletter issue
 * @returns Word count
 */
export function wordCount(issue: Issue): number {
  return issue.sections.reduce((total, s) => {
    const text = [s.content, s.cta?.text].join(' ').toLowerCase();
    return total + text.split(/\s+/).filter(Boolean).length;
  }, 0);
}