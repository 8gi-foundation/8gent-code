/**
 * Represents structured podcast show notes.
 */
class ShowNotes {
  title: string;
  guest?: string;
  duration?: string;
  topics: string[];
  summary?: string;
  timestamps: { time: string; topic: string }[];
  quotes: { text: string; speaker: string; timecode: string }[];
  constructor({
    title,
    guest,
    duration,
    topics,
  }: {
    title: string;
    guest?: string;
    duration?: string;
    topics: string[];
  }) {
    this.title = title;
    this.guest = guest;
    this.duration = duration;
    this.topics = topics;
    this.summary = '';
    this.timestamps = [];
    this.quotes = [];
  }
}

/**
 * Builds a new ShowNotes instance.
 * @param params - Initialization parameters.
 * @returns ShowNotes instance.
 */
export function buildShowNotes({
  title,
  guest,
  duration,
  topics,
}: {
  title: string;
  guest?: string;
  duration?: string;
  topics: string[];
}): ShowNotes {
  return new ShowNotes({ title, guest, duration, topics });
}

/**
 * Adds a timestamp to show notes.
 * @param notes - ShowNotes instance.
 * @param params - Timestamp parameters.
 */
export function addTimestamp(
  notes: ShowNotes,
  { time, topic }: { time: string; topic: string }
): void {
  notes.timestamps.push({ time, topic });
}

/**
 * Adds a quote to show notes.
 * @param notes - ShowNotes instance.
 * @param params - Quote parameters.
 */
export function addQuote(
  notes: ShowNotes,
  { text, speaker, timecode }: { text: string; speaker: string; timecode: string }
): void {
  notes.quotes.push({ text, speaker, timecode });
}

/**
 * Renders show notes as markdown.
 * @param notes - ShowNotes instance.
 * @returns Markdown string.
 */
export function renderMarkdown(notes: ShowNotes): string {
  return `# ${notes.title}\n\n**Guest:** ${notes.guest || 'N/A'}\n**Duration:** ${
    notes.duration || 'N/A'
  }\n\n## Summary\n${notes.summary || 'No summary provided.'}\n\n## Topics\n- ${
    notes.topics.join('\n- ')
  }\n\n## Timestamps\n${notes.timestamps
    .map(({ time, topic }) => `- ${time}: ${topic}`)
    .join('\n')}\n\n## Quotes\n${notes.quotes
    .map(({ text, speaker, timecode }) => `> ${text} — ${speaker} (${timecode})`)
    .join('\n')}`;
}

/**
 * Renders SEO-optimized description.
 * @param notes - ShowNotes instance.
 * @returns SEO description under 300 words.
 */
export function renderSEO(notes: ShowNotes): string {
  const content = [
    notes.title,
    notes.guest,
    notes.summary,
    ...notes.topics,
    ...notes.timestamps.map(({ topic }) => topic),
    ...notes.quotes.map(({ text }) => text),
  ].join(' ');

  return content
    .split(/\s+/)
    .filter((_, i, arr) => i < 100)
    .join(' ');
}