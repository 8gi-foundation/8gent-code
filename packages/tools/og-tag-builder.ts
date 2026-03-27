interface OGProperties {
  title: string;
  description: string;
  image: string;
  url: string;
  type?: string;
  siteName?: string;
}

interface TwitterCardMeta {
  title: string;
  description: string;
  image: string;
  card?: string;
}

/**
 * Builds Open Graph properties object
 * @param params - Required and optional parameters
 * @returns OG properties object
 */
export function buildOG(params: { title: string; description: string; image: string; url: string; type?: string; siteName?: string }): OGProperties {
  return {
    title: params.title,
    description: params.description,
    image: params.image,
    url: params.url,
    type: params.type,
    siteName: params.siteName,
  };
}

/**
 * Builds Twitter Card meta object
 * @param params - Required and optional parameters
 * @returns Twitter Card meta object
 */
export function buildTwitterCard(params: { title: string; description: string; image: string; card?: string }): TwitterCardMeta {
  return {
    title: params.title,
    description: params.description,
    image: params.image,
    card: params.card || 'summary_large_image',
  };
}

/**
 * Renders OG and Twitter Card tags as HTML strings
 * @param og - OG properties object
 * @param twitter - Twitter Card meta object
 * @returns HTML strings for both tag sets
 */
export function renderHTML(og: OGProperties, twitter: TwitterCardMeta): { og: string; twitter: string } {
  const ogTags = Object.entries(og).map(([key, value]) => `<meta property="og:${key}" content="${value}">`).join('\n');
  const twitterTags = Object.entries(twitter).map(([key, value]) => {
    if (key === 'card') return `<meta name="twitter:card" content="${value}">`;
    return `<meta name="twitter:${key}" content="${value}">`;
  }).join('\n');
  return { og: ogTags, twitter: twitterTags };
}

/**
 * Validates required OG properties and image dimensions
 * @param og - OG properties object
 * @returns Validation result
 */
export function validate(og: OGProperties): { valid: boolean; error?: string } {
  if (!og.title || !og.description || !og.image || !og.url) {
    return { valid: false, error: 'Missing required OG properties: title, description, image, url' };
  }
  const imageRegex = /\?width=(\d+)&height=(\d+)/;
  const match = og.image.match(imageRegex);
  if (!match) {
    return { valid: false, error: 'Image URL should include width and height parameters' };
  }
  return { valid: true };
}

/**
 * Generates ASCII card preview of how share will look
 * @param og - OG properties object
 * @returns ASCII card preview
 */
export function preview(og: OGProperties): string {
  const title = og.title.padEnd(30, ' ');
  const description = og.description.padEnd(30, ' ');
  return `+----------------------------+\n| ${title} |\n+----------------------------+\n| ${description} |\n+----------------------------+\n| [Image Placeholder]      |\n+----------------------------+`;
}