/**
 * @8gent/repo-context - Intelligent repo context selection
 *
 * Scans a repository, builds an import graph, ranks files by relevance
 * to a query, and returns context within a token budget.
 */

export { RepoMapper, type FileEntry, type RankedFile } from "./mapper";

let _instance: InstanceType<typeof import("./mapper").RepoMapper> | null = null;

/** Singleton RepoMapper - scans once per session */
export async function getRepoMapper(rootDir?: string): Promise<InstanceType<typeof import("./mapper").RepoMapper>> {
  if (_instance) return _instance;
  const { RepoMapper } = await import("./mapper");
  _instance = new RepoMapper();
  await _instance.scan(rootDir ?? process.cwd());
  return _instance;
}
