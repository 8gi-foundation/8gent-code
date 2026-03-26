/**
 * Press release structure interface.
 */
interface Release {
  headline: string;
  subheadline?: string;
  dateline: string;
  body: string[];
  quote?: string;
  boilerplate: string;
  contact?: string;
}

/**
 * Builds a press release object.
 */
function buildRelease({
  headline,
  subheadline,
  dateline,
  body,
  quote,
  boilerplate,
  contact
}: {
  headline: string;
  subheadline?: string;
  dateline: string;
  body: string[];
  quote?: string;
  boilerplate: string;
  contact?: string;
}): Release {
  return {
    headline,
    subheadline,
    dateline,
    body,
    quote,
    boilerplate,
    contact
  };
}

/**
 * Validates required fields in a press release.
 */
function validateStructure(release: Release): boolean {
  return release.headline && release.dateline && release.boilerplate;
}

/**
 * Counts total words in a press release.
 */
function wordCount(release: Release): number {
  const text = [
    release.headline,
    release.subheadline || '',
    release.dateline,
    ...release.body,
    release.quote || '',
    release.boilerplate,
    release.contact || ''
  ].join(' ');
  return text.split(/\s+/).length;
}

/**
 * Renders press release as AP-style text.
 */
function renderText(release: Release): string {
  let text = release.headline.toUpperCase() + '\n\n';
  if (release.subheadline) text += release.subheadline + '\n\n';
  text += release.dateline + '\n\n';
  text += release.body.join('\n\n') + '\n\n';
  if (release.quote) text += `"${release.quote}"\n\n`;
  text += release.boilerplate + '\n\n';
  if (release.contact) text += release.contact;
  return text;
}

/**
 * Renders press release as basic HTML with semantic markup.
 */
function renderHTML(release: Release): string {
  let html = '<article>\n';
  html += `<h1>${release.headline}</h1>\n`;
  if (release.subheadline) html += `<h2>${release.subheadline}</h2>\n`;
  html += `<p>${release.dateline}</p>\n`;
  release.body.forEach(para => html += `<p>${para}</p>\n`);
  if (release.quote) html += `<blockquote>"${release.quote}"</blockquote>\n`;
  html += `<p>${release.boilerplate}</p>\n`;
  if (release.contact) html += `<footer>${release.contact}</footer>\n`;
  html += '</article>';
  return html;
}

export { buildRelease, validateStructure, wordCount, renderText, renderHTML };