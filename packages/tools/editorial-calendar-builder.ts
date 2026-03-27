/**
 * Represents an entry in the editorial calendar.
 */
interface Entry {
  id: string;
  date: string;
  channel: string;
  format: string;
  title: string;
  author: string;
  status: 'draft' | 'in progress' | 'published';
}

/**
 * Editorial calendar containing entries and channels.
 */
class Calendar {
  entries: Entry[];
  channels: string[];

  constructor(channels: string[]) {
    this.entries = [];
    this.channels = [...new Set(channels)];
  }
}

/**
 * Creates a new editorial calendar with specified channels.
 * @param period - Calendar period (not currently used)
 * @param channels - Array of channel names
 * @returns New Calendar instance
 */
function createCalendar(period: string, channels: string[]): Calendar {
  return new Calendar(channels);
}

/**
 * Adds an entry to the calendar.
 * @param calendar - Target calendar
 * @param entry - Entry data (without id)
 * @returns void
 */
function addEntry(calendar: Calendar, entry: Omit<Entry, 'id'>): void {
  const newEntry: Entry = {
    ...entry,
    id: Math.random().toString(36).substr(2, 9),
  };
  calendar.entries.push(newEntry);
}

/**
 * Assigns an entry to an author.
 * @param calendar - Target calendar
 * @param id - Entry ID
 * @param author - Author name
 * @returns void
 */
function assignEntry(calendar: Calendar, id: string, author: string): void {
  const entry = calendar.entries.find(e => e.id === id);
  if (entry) entry.author = author;
}

/**
 * Finds overdue entries (not published and past due date).
 * @param calendar - Target calendar
 * @param now - Current date (YYYY-MM-DD format)
 * @returns Array of overdue entries
 */
function overdue(calendar: Calendar, now = new Date().toISOString().split('T')[0]): Entry[] {
  return calendar.entries.filter(e => e.date < now && e.status !== 'published');
}

/**
 * Renders calendar as ASCII grid.
 * @param calendar - Target calendar
 * @returns ASCII grid string
 */
function renderCalendar(calendar: Calendar): string {
  const dates = [...new Set(calendar.entries.map(e => e.date))].sort();
  const headers = [''].concat(dates);
  const rows = calendar.channels.map(channel => {
    const row = [channel];
    dates.forEach(date => {
      const entry = calendar.entries.find(e => e.date === date && e.channel === channel);
      let cell = ' ';
      if (entry) {
        cell = entry.status === 'published' ? '■' : entry.status === 'in progress' ? '○' : '●';
        cell += ` ${entry.title}`;
      }
      row.push(cell);
    });
    return row.join(' | ');
  });
  return headers.join(' | ') + '\n' + rows.join('\n');
}

export { Calendar, createCalendar, addEntry, assignEntry, overdue, renderCalendar };