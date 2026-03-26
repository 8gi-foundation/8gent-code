/**
 * Represents a day in the content calendar with channels, themes, and posts.
 */
interface CalendarDay {
  date: Date;
  theme: string;
  channels: Channel[];
}

/**
 * Represents a channel with its allocated posts.
 */
interface Channel {
  name: string;
  posts: string[];
}

/**
 * Generates a content calendar for a given month and year.
 * @param month - The month (0-11).
 * @param year - The year.
 * @param channels - Array of channels with names.
 * @param postsPerWeek - Number of posts per channel per week.
 * @returns Array of CalendarDay objects.
 */
function generate(month: number, year: number, channels: { name: string }[], postsPerWeek: number): CalendarDay[] {
  const days: CalendarDay[] = [];
  const date = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();

  for (let day = 1; day <= lastDay; day++) {
    days.push({
      date: new Date(year, month, day),
      theme: '',
      channels: channels.map(channel => ({ name: channel.name, posts: [] })),
    });
  }

  return days;
}

/**
 * Assigns a theme to a specific week in the calendar.
 * @param calendar - The calendar to modify.
 * @param weekNumber - The week number (1-based).
 * @param theme - The theme to assign.
 */
function assignTheme(calendar: CalendarDay[], weekNumber: number, theme: string): void {
  const startDay = (weekNumber - 1) * 7;
  for (let i = startDay; i < startDay + 7 && i < calendar.length; i++) {
    calendar[i].theme = theme;
  }
}

/**
 * Distributes content items into available slots across channels.
 * @param calendar - The calendar to fill.
 * @param contentItems - Array of content titles to distribute.
 */
function fillSlots(calendar: CalendarDay[], contentItems: string[]): void {
  const postsPerDay = Math.floor(contentItems.length / calendar.length);
  let index = 0;

  for (const day of calendar) {
    for (const channel of day.channels) {
      for (let i = 0; i < postsPerDay && index < contentItems.length; i++) {
        channel.posts.push(contentItems[index++]);
      }
    }
  }
}

/**
 * Renders the calendar as an ASCII grid.
 * @param calendar - The calendar to render.
 * @returns ASCII string representation of the calendar.
 */
function renderCalendar(calendar: CalendarDay[]): string {
  const header = 'Mon Tue Wed Thu Fri Sat Sun';
  const rows: string[] = [header];

  for (const day of calendar) {
    let row = '';
    for (const channel of day.channels) {
      row += channel.posts.map(post => post.slice(0, 3)).join(' ') + ' ';
    }
    rows.push(row);
  }

  return rows.join('\n');
}

/**
 * Exports the calendar to CSV format.
 * @param calendar - The calendar to export.
 * @returns CSV string with date, channel, title, status.
 */
function exportCSV(calendar: CalendarDay[]): string {
  const csvLines: string[] = ['date,channel,title,status'];
  for (const day of calendar) {
    for (const channel of day.channels) {
      for (const post of channel.posts) {
        csvLines.push(`${day.date.toISOString().split('T')[0]},${channel.name},${post},"scheduled"`);
      }
    }
  }
  return csvLines.join('\n');
}

export { generate, assignTheme, fillSlots, renderCalendar, exportCSV };