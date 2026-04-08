/**
 * Analyzes text for hallucination risk patterns
 */
export class HallucinationAnalyzer {
  /**
   * Detects uncertainty markers in text
   * @param text - Text to analyze
   * @returns Count of uncertainty markers
   */
  detectUncertaintyMarkers(text: string): number {
    const matches = text.match(/\b(?:i believe|might be|i think|perhaps|maybe)\b/i);
    return matches ? matches.length : 0;
  }

  /**
   * Detects overconfident claims in text
   * @param text - Text to analyze
   * @returns Count of overconfident claims
   */
  detectOverconfidence(text: string): number {
    const matches = text.match(/\bthe\s+(\d{4}|\d+\s+million)/gi);
    return matches ? matches.length : 0;
  }

  /**
   * Checks for contradictions with known facts
   * @param text - Text to analyze
   * @param facts - Array of known facts
   * @returns Count of contradictions
   */
  checkFactConsistency(text: string, facts: string[]): number {
    return facts.filter(fact => !text.includes(fact)).length;
  }

  /**
   * Calculates hallucination risk score (0-100)
   * @param text - Text to analyze
   * @param facts - Array of known facts
   * @returns Risk score
   */
  score(text: string, facts: string[]): number {
    const uncertainty = this.detectUncertaintyMarkers(text);
    const overconfidence = this.detectOverconfidence(text);
    const contradictions = this.checkFactConsistency(text, facts);
    return Math.round(((uncertainty * 2 + overconfidence * 3 + contradictions * 5) / 100) * 100);
  }

  /**
   * Generates markdown hallucination report
   * @param analysis - Analysis results
   * @returns Markdown report
   */
  renderReport(analysis: { uncertainty: number; overconfidence: number; contradictions: number; score: number }): string {
    return `# Hallucination Risk Report\n\n**Risk Score:** ${analysis.score}/100\n\n## Findings\n- Uncertainty markers: ${analysis.uncertainty}\n- Overconfident claims: ${analysis.overconfidence}\n- Contradictions with facts: ${analysis.contradictions}`;
  }
}