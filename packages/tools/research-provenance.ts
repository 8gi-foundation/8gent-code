/**
 * Creates a provenance tracker for a research artifact.
 * @param slug - The slug used to generate the sidecar filename.
 * @returns A new ProvenanceTracker instance.
 */
export function createProvenance(slug: string): ProvenanceTracker {
  return new ProvenanceTracker(slug);
}

/**
 * Tracks provenance information for a research artifact.
 */
class ProvenanceTracker {
  private slug: string;
  private sources: { url: string; status: 'found' | 'accepted' | 'rejected' }[] = [];
  private claims: { text: string; sourceUrl: string; verified: boolean }[] = [];
  private rounds: number = 0;
  private totalSources: number = 0;
  private accepted: number = 0;
  private rejected: number = 0;

  constructor(slug: string) {
    this.slug = slug;
  }

  /**
   * Adds a source with its status.
   * @param url - The source URL.
   * @param status - Status of the source ('found', 'accepted', or 'rejected').
   */
  addSource(url: string, status: 'found' | 'accepted' | 'rejected'): void {
    this.sources.push({ url, status });
    this.totalSources += 1;
    if (status === 'accepted') this.accepted += 1;
    else if (status === 'rejected') this.rejected += 1;
    this.rounds += 1;
  }

  /**
   * Adds a claim with its source and verification status.
   * @param text - The claim text.
   * @param sourceUrl - The source URL of the claim.
   * @param verified - Whether the claim is verified.
   */
  addClaim(text: string, sourceUrl: string, verified: boolean): void {
    this.claims.push({ text, sourceUrl, verified });
  }

  /**
   * Generates a markdown representation of the provenance data.
   * @returns Markdown content as a string.
   */
  toMarkdown(): string {
    let md = `# ${this.slug}.provenance.md\n\n`;
    md += '## Sources\n';
    this.sources.forEach((src, i) => {
      md += `${i + 1}. [${src.url}](#${src.status})\n`;
    });
    md += '\n## Claims\n';
    this.claims.forEach((claim, i) => {
      md += `${i + 1}. ${claim.text} (Source: [${claim.sourceUrl}](#${claim.sourceUrl}), Verified: ${claim.verified ? 'Yes' : 'No'})\n`;
    });
    md += '\n## Statistics\n';
    md += `Total Sources: ${this.totalSources}\n`;
    md += `Accepted: ${this.accepted}\n`;
    md += `Rejected: ${this.rejected}\n`;
    md += `Rounds: ${this.rounds}\n`;
    return md;
  }
}