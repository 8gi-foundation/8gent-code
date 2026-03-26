/**
 * Parses meeting notes into structured data
 * @param text - Raw meeting notes text
 * @returns Parsed meeting data
 */
export function parse(text: string): ParsedMeeting {
  const sections = text.split(/\n\n+/);
  const attendees = sections[0].match(/Attendees: (.+)/)?.[1].split(', ') || [];
  const decisions = parseList(sections[1]);
  const actions = extractActions(text);
  const blockers = detectBlockers(text);
  return { attendees, decisions, actions, blockers };
}

/**
 * Extracts action items from text
 * @param text - Raw meeting notes text
 * @returns Array of action items
 */
export function extractActions(text: string): ActionItem[] {
  const matches = text.match(/Action: (.+?) Owner: (.+?) Deadline: (.+)/g) || [];
  return matches.map(m => {
    const [_, task, owner, deadline] = m.match(/(.+?) Owner: (.+?) Deadline: (.+)/)!;
    return { task, owner, deadline };
  });
}

/**
 * Formats parsed meeting data into markdown
 * @param parsed - Parsed meeting data
 * @returns Markdown summary
 */
export function formatSummary(parsed: ParsedMeeting): string {
  return `## Meeting Summary\n\n**Attendees:** ${parsed.attendees.join(', ')}\n\n` +
         `### Decisions\n${parsed.decisions.map(d => `- ${d}`).join('\n')}\n\n` +
         `### Actions\n${parsed.actions.map(a => `- **${a.task}** (Owner: ${a.owner}, Deadline: ${a.deadline})`).join('\n')}\n\n` +
         `### Blockers\n${parsed.blockers.map(b => `- ${b}`).join('\n')}`;
}

/**
 * Detects blockers in text
 * @param text - Raw meeting notes text
 * @returns Array of blocker notes
 */
export function detectBlockers(text: string): string[] {
  const matches = text.match(/(BLOCKED|blocker).+?(?=\n|$)/g) || [];
  return matches.map(m => m.replace(/BLOCKED|blocker/i, '').trim());
}

/**
 * Exports action items as checklist
 * @param parsed - Parsed meeting data
 * @returns Markdown checklist
 */
export function exportTasks(parsed: ParsedMeeting): string {
  return parsed.actions.map(a => `- [ ] **${a.task}** (Owner: ${a.owner}, Deadline: ${a.deadline})`).join('\n');
}

interface ParsedMeeting {
  attendees: string[];
  decisions: string[];
  actions: ActionItem[];
  blockers: string[];
}

interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
}

function parseList(text: string): string[] {
  return text.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
}