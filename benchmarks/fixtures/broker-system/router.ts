/**
 * Topic Router — Pattern-based topic matching with wildcards.
 *
 * Supports wildcard patterns for flexible topic subscriptions:
 *  - `*`       matches any single topic (universal wildcard)
 *  - `user.*`  matches any topic starting with "user." followed by
 *              zero or more characters (e.g., "user.", "user.created",
 *              "user.profile.updated")
 *  - `*.event` matches any topic ending with ".event" (e.g., ".event",
 *              "system.event", "user.event")
 *
 * CONTRACT:
 *  - matchPattern(pattern, topic) returns true if the topic matches the pattern.
 *  - `*` alone matches EVERYTHING.
 *  - `prefix.*` matches any topic that starts with "prefix." — including
 *    "prefix." itself (empty suffix), because `*` matches ZERO or more characters.
 *  - `*.suffix` matches any topic that ends with ".suffix" — including
 *    ".suffix" itself (empty prefix), because `*` matches ZERO or more characters.
 *  - Literal patterns (no wildcards) match only exact strings.
 */

export class TopicRouter {
  /**
   * Tests whether a concrete topic matches a pattern.
   *
   * @param pattern The pattern string (may contain `*` wildcards).
   * @param topic   The concrete topic name to test.
   * @returns true if the topic matches the pattern.
   */
  matchPattern(pattern: string, topic: string): boolean {
    // Exact match — fast path
    if (pattern === topic) return true;

    // Universal wildcard — matches everything
    if (pattern === "*") return true;

    // No wildcard at all — must be exact (already checked above)
    if (!pattern.includes("*")) return false;

    // Wildcard matching: split on `*` and check prefix/suffix
    const starIndex = pattern.indexOf("*");
    const prefix = pattern.substring(0, starIndex);
    const suffix = pattern.substring(starIndex + 1);

    // The topic must start with the prefix and end with the suffix.
    // The wildcard `*` replaces one or more characters in between.
    if (prefix.length + suffix.length > topic.length) return false;

    const matchesPrefix = topic.startsWith(prefix);
    const matchesSuffix = suffix === "" || topic.endsWith(suffix);

    // Ensure the prefix and suffix don't overlap in the topic
    if (matchesPrefix && matchesSuffix) {
      const wildcardPart = topic.substring(prefix.length, topic.length - (suffix.length || 0));
      return wildcardPart.length > 0;
    }

    return false;
  }

  /**
   * Filters a list of topics, returning only those that match the pattern.
   */
  filterTopics(pattern: string, topics: string[]): string[] {
    return topics.filter((t) => this.matchPattern(pattern, t));
  }

  /**
   * Returns all patterns (from a list) that match a given concrete topic.
   */
  findMatchingPatterns(topic: string, patterns: string[]): string[] {
    return patterns.filter((p) => this.matchPattern(p, topic));
  }
}
