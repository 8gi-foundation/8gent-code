/**
 * Log entry structure with common fields
 */
interface LogEntry {
  timestamp: Date;
  level?: string;
  message: string;
  status?: number;
  hostname?: string;
  priority?: number;
}

/**
 * Parse JSON log line into LogEntry
 * @param line - JSON log line
 * @returns Parsed log entry
 */
function parseJSON(line: string): LogEntry {
  return JSON.parse(line);
}

/**
 * Parse Apache/Nginx common log format
 * @param line - Log line in common format
 * @returns Parsed log entry
 */
function parseCommonLog(line: string): LogEntry {
  const parts = line.split(/"([^"]+)"/);
  const [dateStr] = parts[2].split(/ /);
  const [ip, _, user, _, request, status, bytes] = parts;
  return {
    timestamp: new Date(dateStr),
    message: request,
    status: parseInt(status),
    hostname: ip,
  };
}

/**
 * Parse RFC 5424 syslog format
 * @param line - Syslog log line
 * @returns Parsed log entry
 */
function parseSyslog(line: string): LogEntry {
  const [priority, rest] = line.split(' ', 2);
  const [timestamp, hostname, _, _, _, message] = rest.split(' ', 6);
  return {
    timestamp: new Date(timestamp),
    message,
    hostname,
    priority: parseInt(priority.replace(/<|>/g, '')),
  };
}

/**
 * Auto-detect log format and parse
 * @param line - Log line
 * @returns Parsed log entry
 */
function parseAuto(line: string): LogEntry {
  if (line.startsWith('{')) return parseJSON(line);
  if (line.startsWith('<')) return parseSyslog(line);
  return parseCommonLog(line);
}

/**
 * Filter log entries by criteria
 * @param entries - Array of log entries
 * @param criteria - Filter options
 * @returns Filtered entries
 */
function filter(
  entries: LogEntry[],
  { level, status, after, before }: { level?: string; status?: number; after?: Date; before?: Date } = {}
): LogEntry[] {
  return entries.filter((e) => {
    if (level && e.level !== level) return false;
    if (status && e.status !== status) return false;
    if (after && e.timestamp < after) return false;
    if (before && e.timestamp > before) return false;
    return true;
  });
}

export { LogEntry, parseJSON, parseCommonLog, parseSyslog, parseAuto, filter };