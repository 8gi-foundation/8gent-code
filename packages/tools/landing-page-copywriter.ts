/**
 * Builds a landing page structure with sections and rendering.
 * @param product Product name
 * @param audience Target audience
 * @param primaryCTA Primary call to action text
 * @param pain Key pain point
 * @param gain Key benefit
 * @returns Page object with section builders
 */
export function buildPage({
  product,
  audience,
  primaryCTA,
  pain,
  gain
}: {
  product: string;
  audience: string;
  primaryCTA: string;
  pain: string;
  gain: string;
}) {
  return {
    /**
     * Generates hero section content
     * @param page Page context
     * @returns Hero section with headline, subheadline, CTA
     */
    heroSection: (page: any) => ({
      headline: `${product} for ${audience}`,
      subheadline: `Solve ${pain} and achieve ${gain}`,
      cta: primaryCTA
    }),

    /**
     * Generates feature section content
     * @param page Page context
     * @param features Array of features with benefit and detail
     * @returns Formatted feature descriptions
     */
    featuresSection: (page: any, features: { benefit: string; detail: string }[]) => 
      features.map(f => `**${f.benefit}**: ${f.detail}`),

    /**
     * Handles objection responses
     * @param objections Array of objections with question and answer
     * @returns FAQ-style objection responses
     */
    objectionHandler: (objections: { question: string; answer: string }[]) => 
      objections.map(o => `**Q:** ${o.question}\n**A:** ${o.answer}`),

    /**
     * Renders full markdown document
     * @param page Page context
     * @returns Complete landing page markdown
     */
    renderMarkdown: (page: any) => {
      const { heroSection, featuresSection, objectionHandler } = page;
      const features = featuresSection(page, []);
      const objections = objectionHandler([]);
      return `# ${heroSection.headline}\n\n${heroSection.subheadline}\n\n[${heroSection.cta}](#)\n\n## Features\n${features.join('\n')}\n\n## FAQs\n${objections.join('\n\n')}`;
    }
  };
}