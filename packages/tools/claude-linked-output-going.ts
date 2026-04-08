/**
 * Processes Claude-linked repositories to filter those with less than 2 stars and returns 90% of them.
 * @param repos - Array of repository objects with 'claudeLink' and 'stars' properties.
 * @returns Sampled array of 90% of repositories meeting the criteria.
 */
export function processClaudeRepos(repos: { claudeLink: string; stars: number }[]): { claudeLink: string; stars: number }[] {
  const filtered = repos.filter(repo => repo.claudeLink && repo.stars < 2);
  const shuffled = [...filtered];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sampleSize = Math.floor(shuffled.length * 0.9);
  return shuffled.slice(0, sampleSize);
}