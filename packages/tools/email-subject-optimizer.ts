/**
 * Email subject line optimizer utility
 */
export class EmailOptimizer {
  /** Built-in list of spam trigger words */
  static spamTriggers(): string[] {
    return [
      "act now", "free", "urgent", "limited time", "guaranteed", "100% free", "click here", 
      "winner", "congratulations", "money back", "no cost", "discount", "deal", "last chance", 
      "exclusive", "urgent offer", "limited", "act fast", "immediate", "urgent", "apply now", 
      "claim your", "get", "save", "lowest price", "only", "urgent", "winner", "free trial", 
      "no obligation", "limited", "act now", "instant", "guaranteed", "100% satisfaction", 
      "breakthrough", "revolutionary", "amazing", "unbelievable", "incredible", "unmatched", 
      "unbeatable", "exclusive", "limited", "urgent", "act now", "click here", "don't miss", 
      "last chance", "final", "last", "only", "limited", "urgent", "immediate", "now", "today"
    ];
  }

  /**
   * Score a subject line for open rate potential, spam risk, length, and personalization
   */
  static score(subject: string): { openRate: number; spamRisk: number; length: number; hasPersonalization: boolean } {
    const lengthScore = Math.min(1, 60 - subject.length) / 60;
    const openRate = Math.max(0.2, Math.min(0.8, lengthScore + (subject.includes("you") ? 0.1 : 0)));
    const spamCount = subject.split(" ").filter(word => EmailOptimizer.spamTriggers().includes(word.toLowerCase())).length;
    const spamRisk = spamCount / 10;
    const hasPersonalization = /[a-zA-Z]+ [a-zA-Z]+/.test(subject) || subject.includes("you");
    return { openRate, spamRisk, length: subject.length, hasPersonalization };
  }

  /**
   * Generate improved subject line suggestions
   */
  static optimize(subject: string): string[] {
    const triggers = EmailOptimizer.spamTriggers();
    const replacements = {
      "free": "complimentary", "urgent": "important", "limited time": "special offer", 
      "click here": "learn more", "winner": "recipient", "deal": "opportunity"
    };
    return Object.entries(replacements).map(([trigger, replacement]) => 
      subject.replace(new RegExp(trigger, "gi"), replacement)
    ).concat(subject.replace("subject", "personalized"));
  }

  /**
   * Generate N A/B test variants of a subject line
   */
  static abVariants(subject: string, n: number): string[] {
    const variants = [];
    for (let i = 0; i < n; i++) {
      const replaced = subject.replace("subject", `variant ${i + 1}`);
      variants.push(replaced);
    }
    return variants;
  }

  /**
   * Rank subject lines by predicted open rate
   */
  static compare(subjects: string[]): string[] {
    return [...subjects].sort((a, b) => EmailOptimizer.score(b).openRate - EmailOptimizer.score(a).openRate);
  }
}