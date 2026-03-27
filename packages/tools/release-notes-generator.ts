/**
 * Categorizes commits into feat, fix, chore, docs, and breaking changes.
 * @param commits Array of commit objects with message.
 * @returns Object with categorized commits and breaking changes.
 */
function parseCommits(commits: { message: string }[]): { [key: string]: string[]; breakingChanges: string[] } {
  const result = {
    feat: [],
    fix: [],
    chore: [],
    docs: [],
    breakingChanges: [],
  };
  for (const commit of commits) {
    const msg = commit.message.trim();
    if (!msg) continue;
    let type: string | null = null;
    let isBreaking = false;
    if (msg.includes('BREAKING CHANGE')) isBreaking = true;
    const typeMatch = msg.match(/^(\w+):\s+/);
    if (typeMatch) type = typeMatch[1].toLowerCase();
    if (type === 'feat') result.feat.push(msg);
    else if (type === 'fix') result.fix.push(msg);
    else if (type === 'chore') result.chore.push(msg);
    else if (type === 'docs') result.docs.push(msg);
    if (isBreaking) result.breakingChanges.push(msg);
  }
  return result;
}

/**
 * Generates formatted release notes from parsed commits.
 * @param params Object with version, date, and parsed commits.
 * @returns Formatted markdown release notes.
 */
function generateNotes({ version, date, commits }: { version: string; date: string; commits: { [key: string]: string[]; breakingChanges: string[] } }): string {
  let notes = `## ${version} (${date})\n\n`;
  if (commits.breakingChanges.length) {
    notes += '### Breaking Changes\n';
    for (const msg of commits.breakingChanges) notes += `- ${msg}\n`;
    notes += '\n';
  }
  for (const [type, messages] of Object.entries(commits)) {
    if (type === 'breakingChanges') continue;
    if (!messages.length) continue;
    notes += `### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`;
    for (const msg of messages) notes += `- ${msg}\n`;
    notes += '\n';
  }
  return notes;
}

/**
 * Formats an array of notes into a full CHANGELOG.md section.
 * @param notes Array of note objects with version, date, and commits.
 * @returns Full CHANGELOG.md content.
 */
function formatChangelog(notes: { version: string; date: string; commits: { [key: string]: string[]; breakingChanges: string[] } }[]): string {
  return notes.map(n => generateNotes({ version: n.version, date: n.date, commits: n.commits })).join('\n');
}

/**
 * Determines semver bump based on commit changes.
 * @param currentVersion Current version string.
 * @param changes Parsed commit changes.
 * @returns 'major', 'minor', or 'patch'.
 */
function bump(currentVersion: string, changes: { [key: string]: string[]; breakingChanges: string[] }): 'major' | 'minor' | 'patch' {
  if (changes.breakingChanges.length) return 'major';
  if (changes.feat.length) return 'minor';
  if (changes.fix.length) return 'patch';
  return 'patch';
}

/**
 * Renders formatted markdown release notes.
 * @param notes Array of note objects with version, date, and commits.
 * @returns Formatted markdown.
 */
function renderMarkdown(notes: { version: string; date: string; commits: { [key: string]: string[]; breakingChanges: string[] } }[]): string {
  return formatChangelog(notes);
}

export { parseCommits, generateNotes, formatChangelog, bump, renderMarkdown };