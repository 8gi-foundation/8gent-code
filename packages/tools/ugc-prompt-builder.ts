/**
 * Builds a user-generated content prompt based on parameters
 * @param {Object} options - Prompt configuration
 * @param {string} options.type - Type of content (review, photo, video, story, testimonial)
 * @param {string} options.brand - Brand name
 * @param {string} options.product - Product name
 * @param {string} options.platform - Target platform (e.g. Instagram, TikTok)
 * @param {string} [options.incentive] - Optional incentive
 * @returns {string} Generated prompt
 */
function buildPrompt({ type, brand, product, platform, incentive }: { type: string; brand: string; product: string; platform: string; incentive?: string }): string {
  const templates: Record<string, string> = {
    review: "Share your honest review of {product} for {brand} on {platform}. Include what you love and what could be improved.",
    photo: "Show us how you use {product} in your daily life. Post a photo on {platform} with {brand} hashtag.",
    video: "Create a 60s video demonstrating {product} on {platform}. Add {brand} tag for a chance to win {incentive}.",
    story: "Tell your story with {product} in 150 words. Post on {platform} with {brand} handle for consideration.",
    testimonial: "Write a short testimonial about {product} for {brand}. Share on {platform} with {brand} hashtag."
  };
  
  return templates[type]
    .replace(/{brand}/g, brand)
    .replace(/{product}/g, product)
    .replace(/{platform}/g, platform)
    .replace(/{incentive}/g, incentive || "");
}

/**
 * Checks text for prohibited content patterns
 * @param {string} text - Text to moderate
 * @returns {string} Clean text or error message
 */
function moderate(text: string): string {
  const patterns = [
    /hate speech/i,
    /pornography/i,
    /violence/i,
    /discrimination/i
  ];
  
  for (const pattern of patterns) {
    if (pattern.test(text)) return "Content contains prohibited material";
  }
  return text;
}

/**
 * Generates campaign brief document from prompts
 * @param {string[]} prompts - Array of prompts
 * @returns {Object} Campaign brief document
 */
function toCampaignBrief(prompts: string[]): { title: string; introduction: string; prompts: string[] } {
  return {
    title: "UGC Campaign Brief",
    introduction: "Community engagement prompts for social proof collection",
    prompts
  };
}

/**
 * Formats prompts collection for display
 * @param {string[]} prompts - Array of prompts
 * @returns {string} Formatted prompt collection
 */
function renderBatch(prompts: string[]): string {
  return prompts.map((p, i) => `${i + 1}. ${p}`).join("\n\n");
}

export { buildPrompt, moderate, toCampaignBrief, renderBatch };