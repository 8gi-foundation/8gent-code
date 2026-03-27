interface GoogleAd {
  headlines: string[];
  descriptions: string[];
  url: string;
}

interface MetaAd {
  primary: string;
  headline: string;
  description: string;
  cta: string;
}

interface LinkedInAd {
  intro: string;
  headline: string;
  description: string;
}

type AdCopy = GoogleAd | MetaAd | LinkedInAd;

/**
 * Truncates a string to a maximum length
 * @param {string} str - Input string
 * @param {number} limit - Maximum length
 * @returns {string} - Truncated string
 */
function truncate(str: string, limit: number): string {
  return str.length > limit ? str.slice(0, limit) : str;
}

/**
 * Generates Google Ads copy with 3 headlines (≤30 chars) and 2 descriptions (≤90 chars)
 * @param {Object} params - Parameters
 * @param {string} params.headline - Main headline
 * @param {string} params.description - Main description
 * @param {string} params.url - Landing URL
 * @returns {GoogleAd} - Generated ad copy
 */
function googleAd({ headline, description, url }: { headline: string; description: string; url: string }): GoogleAd {
  return {
    headlines: [truncate(headline, 30), truncate(headline, 30), truncate(headline, 30)],
    descriptions: [truncate(description, 90), truncate(description, 90)],
    url
  };
}

/**
 * Generates Meta Ads copy
 * @param {Object} params - Parameters
 * @param {string} params.primary - Primary text
 * @param {string} params.headline - Headline
 * @param {string} params.description - Description
 * @param {string} params.cta - Call to action
 * @returns {MetaAd} - Generated ad copy
 */
function metaAd({ primary, headline, description, cta }: { primary: string; headline: string; description: string; cta: string }): MetaAd {
  return { primary, headline, description, cta };
}

/**
 * Generates LinkedIn Ads copy
 * @param {Object} params - Parameters
 * @param {string} params.intro - Intro text
 * @param {string} params.headline - Headline
 * @param {string} params.description - Description
 * @returns {LinkedInAd} - Generated ad copy
 */
function linkedInAd({ intro, headline, description }: { intro: string; headline: string; description: string }): LinkedInAd {
  return { intro, headline, description };
}

/**
 * Validates character limits for all ad platforms
 * @param {AdCopy} copy - Ad copy to validate
 * @returns {boolean} - True if all limits are met
 */
function checkLimits(copy: AdCopy): boolean {
  if ('headlines' in copy && 'descriptions' in copy) {
    for (const h of copy.headlines) if (h.length > 30) return false;
    for (const d of copy.descriptions) if (d.length > 90) return false;
  } else if ('primary' in copy && 'cta' in copy) {
    if (copy.primary.length > 120) return false;
    if (copy.headline.length > 120) return false;
    if (copy.description.length > 120) return false;
    if (copy.cta.length > 20) return false;
  } else if ('intro' in copy) {
    if (copy.intro.length > 120) return false;
    if (copy.headline.length > 120) return false;
    if (copy.description.length > 120) return false;
  }
  return true;
}

/**
 * Renders a formatted ad preview for the specified platform
 * @param {AdCopy} copy - Ad copy to render
 * @param {string} platform - Target platform ('google', 'meta', 'linkedin')
 * @returns {string} - Formatted preview
 */
function renderPreview(copy: AdCopy, platform: 'google' | 'meta' | 'linkedin'): string {
  switch (platform) {
    case 'google':
      return `Headlines:\n- ${copy.headlines.join('\n- ')}\n\nDescriptions:\n- ${copy.descriptions.join('\n- ')}\n\nURL: ${copy.url}`;
    case 'meta':
      return `Primary: ${copy.primary}\nHeadline: ${copy.headline}\nDescription: ${copy.description}\nCTA: ${copy.cta}`;
    case 'linkedin':
      return `Intro: ${copy.intro}\nHeadline: ${copy.headline}\nDescription: ${copy.description}`;
    default:
      return 'Invalid platform';
  }
}

export {
  googleAd,
  metaAd,
  linkedInAd,
  checkLimits,
  renderPreview
};