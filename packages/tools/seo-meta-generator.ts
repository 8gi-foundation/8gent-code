/**
 * Generates SEO-optimized meta tags.
 */
export interface Meta {
  title: string;
  description: string;
  canonical: string;
  og: {
    title: string;
    description: string;
    image?: string;
    url: string;
    type?: string;
  };
  twitter: {
    card: string;
    title: string;
    description: string;
    image?: string;
  };
}

/**
 * Generates a meta tag set.
 * @param options - Title, description, URL, image, and type.
 * @returns SEO-optimized meta tags.
 */
export function generate({
  title,
  description,
  url,
  image,
  type = 'website'
}: {
  title: string;
  description: string;
  url: string;
  image?: string;
  type?: string;
}): Meta {
  return {
    title: titleTag(title),
    description: metaDescription(description),
    canonical: url,
    og: {
      title: titleTag(title),
      description: metaDescription(description),
      image,
      url,
      type
    },
    twitter: {
      card: 'summary_large_image',
      title: titleTag(title),
      description: metaDescription(description),
      image
    }
  };
}

/**
 * Optimizes title for SEO (max 60 chars).
 * @param title - Title text.
 * @param siteName - Optional site name to append.
 * @returns Truncated and optimized title.
 */
export function titleTag(title: string, siteName?: string): string {
  let result = title;
  if (siteName) result += ` - ${siteName}`;
  return result.length > 60 ? result.slice(0, 60) : result;
}

/**
 * Optimizes meta description (max 155 chars).
 * @param description - Description text.
 * @returns Truncated description with keyword density.
 */
export function metaDescription(description: string): string {
  let result = description.trim();
  if (result.length > 155) result = result.slice(0, 155);
  return result;
}

/**
 * Renders meta tags as HTML strings.
 * @param meta - Meta tag set.
 * @returns HTML meta tag strings.
 */
export function renderHTML(meta: Meta): string[] {
  return [
    `<title>${meta.title}</title>`,
    `<meta name="description" content="${meta.description}">`,
    `<link rel="canonical" href="${meta.canonical}">`,
    `<meta property="og:title" content="${meta.og.title}">`,
    `<meta property="og:description" content="${meta.og.description}">`,
    `<meta property="og:url" content="${meta.og.url}">`,
    meta.og.type ? `<meta property="og:type" content="${meta.og.type}">` : '',
    meta.og.image ? `<meta property="og:image" content="${meta.og.image}">` : '',
    `<meta name="twitter:card" content="${meta.twitter.card}">`,
    `<meta name="twitter:title" content="${meta.twitter.title}">`,
    `<meta name="twitter:description" content="${meta.twitter.description}">`,
    meta.twitter.image ? `<meta name="twitter:image" content="${meta.twitter.image}">` : ''
  ].filter(Boolean);
}

/**
 * Validates meta tag set.
 * @param meta - Meta tag set.
 * @returns Validation result.
 */
export function validate(meta: Meta): boolean {
  return (
    meta.title.length <= 60 &&
    meta.description.length <= 155 &&
    meta.canonical &&
    meta.og.url === meta.canonical &&
    ['article', 'website'].includes(meta.og.type || '')
  );
}