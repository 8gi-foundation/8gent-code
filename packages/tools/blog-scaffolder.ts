/**
 * Blog post structure
 */
interface BlogPost {
  title: string;
  metaDescription: string;
  slug: string;
  outline: string[];
  sections: { title: string; content: string }[];
  wordCount: number;
  audience: string;
  readingTime: number;
}

/**
 * Generate H2/H3 outline with subtopics
 */
function generateOutline(topic: string, sections?: string[]): string[] {
  if (sections) return sections;
  const parts = topic.split(' ').slice(0, 4);
  return [
    `Introduction to ${topic}`,
    ...parts.map(p => `Key Concepts: ${p}`),
    `Conclusion and Next Steps`
  ];
}

/**
 * Create SEO meta description
 */
function metaDescription(title: string, keywords: string[]): string {
  return `${title} - Explore ${keywords.join(', ')} and practical implementation details. ${title} guide for developers.`.slice(0, 150);
}

/**
 * Estimate reading time in minutes
 */
function readingTime(wordCount: number): number {
  return Math.ceil(wordCount / 250);
}

/**
 * Render markdown template with stubs
 */
function renderMarkdown(post: BlogPost): string {
  return `---
title: ${post.title}
description: ${post.metaDescription}
slug: ${post.slug}
---

# ${post.title}

## ${post.outline[0]}

This section introduces the core concepts of ${post.title} and its relevance to ${post.audience}.

## ${post.outline[1]}

Key implementation details and best practices for working with ${post.title} in real-world scenarios.

## ${post.outline[2]}

Summary of key takeaways and recommendations for further exploration of ${post.title} topics.
`;
}

/**
 * Scaffold blog post structure
 */
function scaffold({
  topic,
  keywords = [],
  audience = 'developers',
  wordCount = 1000
}: {
  topic: string;
  keywords?: string[];
  audience?: string;
  wordCount?: number;
}): BlogPost {
  const title = `${topic.charAt(0).toUpperCase() + topic.slice(1)}`;
  const slug = topic.toLowerCase().replace(/ /g, '-');
  const outline = generateOutline(topic);
  const sections = outline.map(h => ({ title: h, content: `## ${h}\n\nStub content for ${h} section.` }));
  return {
    title,
    metaDescription: metaDescription(title, keywords),
    slug,
    outline,
    sections,
    wordCount,
    audience,
    readingTime: readingTime(wordCount)
  };
}

export { BlogPost, scaffold, generateOutline, metaDescription, readingTime, renderMarkdown };