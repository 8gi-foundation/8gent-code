/**
 * Formats a date using a pattern string.
 * @param date - The date to format.
 * @param pattern - The pattern to use (e.g., 'YYYY-MM-DD').
 * @returns The formatted date string.
 */
function format(date: Date, pattern: string): string {
  const tokens = {
    'YYYY': () => date.getFullYear().toString(),
    'MM': () => (date.getMonth() + 1).toString().padStart(2, '0'),
    'DD': () => date.getDate().toString().padStart(2, '0'),
    'HH': () => date.getHours().toString().padStart(2, '0'),
    'mm': () => date.getMinutes().toString().padStart(2, '0'),
    'ss': () => date.getSeconds().toString().padStart(2, '0'),
    'SSS': () => date.getMilliseconds().toString().padStart(3, '0'),
    'ddd': () => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()],
    'DDD': () => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS|ddd|DDD/g, (match) => tokens[match]());
}

/**
 * Parses a string into a date using a pattern.
 * @param str - The string to parse.
 * @param pattern - The pattern used to format the string.
 * @returns The parsed date.
 */
function parse(str: string, pattern: string): Date {
  const tokens = pattern.match(/YYYY|MM|DD|HH|mm|ss|SSS|ddd|DDD/g) || [];
  const date = new Date();
  let pos = 0;

  for (const token of tokens) {
    let length = 0;
    switch (token) {
      case 'YYYY': length = 4; break;
      case 'MM': case 'DD': case 'HH': case 'mm': case 'ss': length = 2; break;
      case 'SSS': case 'ddd': case 'DDD': length = 3; break;
    }
    const part = str.substr(pos, length);
    pos += length;

    switch (token) {
      case 'YYYY': date.setFullYear(parseInt(part, 10)); break;
      case 'MM': date.setMonth(parseInt(part, 10) - 1); break;
      case 'DD': date.setDate(parseInt(part, 10)); break;
      case 'HH': date.setHours(parseInt(part, 10)); break;
      case 'mm': date.setMinutes(parseInt(part, 10)); break;
      case 'ss': date.setSeconds(parseInt(part, 10)); break;
      case 'SSS': date.setMilliseconds(parseInt(part, 10)); break;
      case 'ddd': {
        const dayIndex = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part);
        if (dayIndex !== -1) date.setDate(date.getDate() + (dayIndex - date.getDay() + 7) % 7);
        break;
      }
      case 'DDD': {
        const monthIndex = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(part);
        if (monthIndex !== -1) date.setMonth(monthIndex);
        break;
      }
    }
  }
  return date;
}

/**
 * Formats a date as a relative time string (e.g., '2 hours ago').
 * @param date - The date to format.
 * @param now - The reference date (defaults to current time).
 * @returns The relative time string.
 */
function relative(date: Date, now: Date = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const units = [
    { ms: 31536000000, singular: 'year', plural: 'years' },
    { ms: 2592000000, singular: 'month', plural: 'months' },
    { ms: 86400000, singular: 'day', plural: 'days' },
    { ms: 3600000, singular: 'hour', plural: 'hours' },
    { ms: 60000, singular: 'minute', plural: 'minutes' },
    { ms: 1000, singular: 'second', plural: 'seconds' }
  ];

  if (diff < 0) {
    const absDiff = -diff;
    for (const unit of units) {
      const count = Math.floor(absDiff / unit.ms);
      if (count > 0) return `in ${count} ${count === 1 ? unit.singular : unit.plural}`;
    }
    return 'now';
  } else {
    for (const unit of units) {
      const count = Math.floor(diff / unit.ms);
      if (count > 0) return `${count} ${count === 1 ? unit.singular : unit.plural} ago`;
    }
    return 'now';
  }
}

export { format, parse, relative };