/**
 * Unified feed item
 */
interface Item {
  title: string;
  link: string;
  description: string;
  date: string;
  author: string;
}

/**
 * Parsed feed
 */
interface Feed {
  title: string;
  link: string;
  items: Item[];
}

/**
 * Parse XML string to Feed
 * @param xmlString - XML content
 * @returns Parsed Feed
 */
function parse(xmlString: string): Feed {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  if (doc.querySelector('feed')) return parseAtom(xmlString);
  return parseRSS(xmlString);
}

/**
 * Parse Atom feed
 * @param xmlString - XML content
 * @returns Parsed Feed
 */
function parseAtom(xmlString: string): Feed {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const feed = doc.querySelector('feed')!;
  const items = Array.from(feed.querySelectorAll('entry')).map(normalizeItem);
  return {
    title: feed.querySelector('title')?.textContent || '',
    link: feed.querySelector('link[rel="alternate"]')?.getAttribute('href') || '',
    items
  };
}

/**
 * Parse RSS 2.0 feed
 * @param xmlString - XML content
 * @returns Parsed Feed
 */
function parseRSS(xmlString: string): Feed {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'text/xml');
  const channel = doc.querySelector('channel')!;
  const items = Array.from(channel.querySelectorAll('item')).map(normalizeItem);
  return {
    title: channel.querySelector('title')?.textContent || '',
    link: channel.querySelector('link')?.textContent || '',
    items
  };
}

/**
 * Normalize item to common schema
 * @param node - XML node
 * @returns Normalized Item
 */
function normalizeItem(node: Element): Item {
  return {
    title: node.querySelector('title')?.textContent || '',
    link: node.querySelector('link')?.textContent || '',
    description: node.querySelector('description')?.textContent || '',
    date: node.querySelector('updated')?.textContent || 
          node.querySelector('pubDate')?.textContent || '',
    author: node.querySelector('author name')?.textContent || 
          node.querySelector('dc:creator')?.textContent || ''
  };
}

/**
 * Render feed summary
 * @param feed - Parsed Feed
 * @returns Formatted string
 */
function renderFeed(feed: Feed): string {
  return `${feed.title} (${feed.items.length} items)\n` +
    feed.items.map(i => 
      `- ${i.title}\n  ${i.link}\n  ${i.description.substring(0, 80)}...`).join('\n');
}

export { Feed, Item, parse, parseAtom, parseRSS, normalizeItem, renderFeed };