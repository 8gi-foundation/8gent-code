/**
 * Scores headlines for emotional value, power words, clarity, and SEO using rule-based analysis.
 */
export class HeadlineAnalyzer {
  /**
   * Returns a list of high-impact power words.
   */
  static powerWords(): string[] {
    return [
      "breakthrough", "revolutionary", "exclusive", "limited", "urgent", "now", "free", "guaranteed", "proven",
      "secret", "amazing", "unbelievable", "ultimate", "master", "win", "avoid", "mistake", "opportunity", "act",
      "today", "last chance", "only", "best", "top", "number one", "unlike anything", "revolutionize", "change your life",
      "unleash", "power", "success", "wealth", "freedom", "happiness", "health", "prosperity", "growth", "increase",
      "double", "triple", "save", "earn", "make money", "invest", "retire", "financial freedom", "no more", "end",
      "stop", "prevent", "solve", "fix", "cure", "heal", "recover", "transform", "change", "improve", "enhance",
      "boost", "maximize", "optimize", "achieve", "attain", "reach", "realize", "fulfill", "satisfy", "fulfillment",
      "joy", "excitement", "thrill", "adventure", "discovery", "exploration", "mystery", "truth", "revelation",
      "insight", "knowledge", "wisdom", "understanding", "clarity", "focus", "attention", "priority", "goal", "objective",
      "target", "mission", "vision", "dream", "aspiration", "ambition", "desire", "want", "need", "requirement",
      "necessity", "essential", "critical", "important", "vital", "key", "main", "primary", "central", "core", "heart",
      "soul", "essence", "spirit", "life", "energy", "force", "momentum", "drive", "motivation", "inspiration",
      "encouragement", "support", "help", "assistance", "guidance", "direction", "navigation", "route", "path", "journey",
      "trip", "voyage", "expedition", "quest", "mission", "adventure", "explore", "discover", "uncover", "reveal",
      "expose", "show", "demonstrate", "prove", "illustrate", "explain", "clarify", "elucidate", "make clear",
      "understand", "comprehend", "grasp", "catch on", "get it", "see", "realize", "acknowledge", "admit", "confess",
      "accept", "embrace", "take on", "assume", "undertake", "commit", "dedicate", "devote", "focus", "concentrate",
      "apply", "use", "utilize", "employ", "leverage", "capitalize", "make the most of", "optimize", "maximize",
      "enhance", "improve", "boost", "increase", "raise", "lift", "elevate", "upgrade", "refine", "polish", "perfect",
      "complete", "finish", "achieve", "attain", "succeed", "win", "thrive", "flourish", "prosper", "grow", "expand",
      "develop", "evolve", "progress", "advance", "move forward", "take steps", "make progress", "achieve success",
      "reach goals", "attain objectives", "complete tasks", "finish projects", "complete missions", "succeed in life",
      "achieve dreams", "realize aspirations", "fulfill ambitions", "meet goals", "achieve targets", "complete challenges",
      "overcome obstacles", "surpass expectations", "exceed standards", "go beyond", "break barriers", "break through",
      "break limits", "break records", "set new standards", "create history", "make a difference", "change the world",
      "transform lives", "impact society", "influence others", "inspire people", "motivate others", "encourage action",
      "drive change", "initiate movement", "start a trend", "lead the way", "be the first", "set the pace", "take the lead",
      "be ahead", "stay ahead", "remain competitive", "maintain edge", "keep leading", "stay on top", "remain number one",
      "be the best", "achieve excellence", "attain mastery", "reach peak performance", "excel in", "succeed in",
      "master the art", "perfect the skill", "refine the technique", "improve the method", "enhance the process",
      "optimize the system", "maximize the outcome", "achieve the goal", "complete the mission", "finish the task",
      "succeed in the challenge", "overcome the obstacle", "surpass the limit", "break the barrier", "cross the line",
      "go beyond", "transcend", "rise above", "excel beyond", "achieve greatness", "reach the pinnacle", "attain the summit",
      "climb to the top", "reach the peak", "ascend to the highest", "attain the highest level", "reach the zenith",
      "achieve the maximum", "attain the ultimate", "reach the pinnacle of success", "succeed in the most challenging",
      "overcome the most difficult", "achieve the impossible", "make the extraordinary", "create the exceptional",
      "produce the remarkable", "generate the outstanding", "deliver the exceptional", "provide the extraordinary",
      "offer the remarkable", "present the outstanding", "showcase the exceptional", "demonstrate the extraordinary",
      "exhibit the remarkable", "display the outstanding", "highlight the exceptional", "emphasize the extraordinary",
      "stress the remarkable", "underscore the outstanding", "reinforce the exceptional", "strengthen the extraordinary",
      "enhance the remarkable", "improve the outstanding", "boost the exceptional", "increase the extraordinary",
      "raise the remarkable", "lift the outstanding", "elevate the exceptional", "upgrade the extraordinary",
      "refine the remarkable", "polish the outstanding", "perfect the exceptional", "complete the extraordinary",
      "finish the remarkable", "achieve the outstanding", "succeed in the exceptional", "thrive in the extraordinary",
      "flourish in the remarkable", "prosper in the outstanding", "grow in the exceptional", "expand in the extraordinary",
      "develop in the remarkable", "evolve in the outstanding", "progress in the exceptional", "advance in the extraordinary",
      "move forward in the remarkable", "take steps in the outstanding", "make progress in the exceptional",
      "achieve success in the extraordinary", "reach goals in the remarkable", "attain objectives in the outstanding",
      "complete tasks in the exceptional", "finish projects in the extraordinary", "complete missions in the remarkable",
      "succeed in life in the outstanding", "achieve dreams in the exceptional", "realize aspirations in the extraordinary",
      "fulfill ambitions in the remarkable", "meet goals in the outstanding", "achieve targets in the exceptional",
      "complete challenges in the extraordinary", "overcome obstacles in the remarkable", "surpass expectations in the outstanding",
      "exceed standards in the exceptional", "go beyond in the extraordinary", "break barriers in the remarkable",
      "break through in the outstanding", "break limits in the exceptional", "break records in the extraordinary",
      "set new standards in the remarkable", "create history in the outstanding", "make a difference in the exceptional",
      "change the world in the extraordinary", "transform lives in the remarkable", "impact society in the outstanding",
      "influence others in the exceptional", "inspire people in the extraordinary", "motivate others in the remarkable",
      "encourage action in the outstanding", "drive change in the exceptional", "initiate movement in the extraordinary",
      "start a trend in the remarkable", "lead the way in the outstanding", "be the first in the exceptional",
      "set the pace in the extraordinary", "take the lead in the remarkable", "be ahead in the outstanding",
      "stay ahead in the exceptional", "remain competitive in the extraordinary", "maintain edge in the remarkable",
      "keep leading in the outstanding", "stay on top in the exceptional", "remain number one in the extraordinary",
      "be the best in the remarkable", "achieve excellence in the outstanding", "attain mastery in the exceptional",
      "reach peak performance in the extraordinary", "excel in the remarkable", "succeed in the outstanding",
      "master the art in the exceptional", "perfect the skill in the extraordinary", "refine the technique in the remarkable",
      "improve the method in the outstanding", "enhance the process in the exceptional", "optimize the system in the extraordinary",
      "maximize the outcome in the remarkable", "achieve the goal in the outstanding", "complete the mission in the exceptional",
      "finish the task in the extraordinary", "succeed in the challenge in the remarkable", "overcome the obstacle in the outstanding",
      "surpass the limit in the exceptional", "break the barrier in the extraordinary", "cross the line in the remarkable",
      "go beyond in the outstanding", "transcend in the exceptional", "rise above in the extraordinary", "excel beyond in the remarkable",
      "achieve greatness in the outstanding", "reach the pinnacle in the exceptional", "attain the summit in the extraordinary",
      "climb to the top in the remarkable", "reach the peak in the outstanding", "ascend to the highest in the exceptional",
      "attain the highest level in the extraordinary", "reach the zenith in the remarkable", "achieve the maximum in the outstanding",
      "attain the ultimate in the exceptional", "reach the pinnacle of success in the extraordinary",
    ];
  }

  /**
   * Scores a headline for emotional value, clarity, SEO, and word count.
   * @param headline - The headline to score.
   * @returns Score object with emotional, clarity, SEO, and word count.
   */
  static score(headline: string): { overall: number; emotional: number; clarity: number; seo: number; wordCount: number } {
    const powerWords = this.powerWords();
    const wordCount = headline.split(" ").length;
    const emotional = powerWords.filter(word => headline.toLowerCase().includes(word.toLowerCase())).length * 2;
    const clarity = Math.max(0, 100 - wordCount * 2);
    const seo = Math.min(100, emotional + (headline.split(" ").length * 1.5));
    const overall = (emotional + clarity + seo) / 3;
    return { overall, emotional, clarity, seo, wordCount };
  }

  /**
   * Analyzes a headline for issues and suggestions.
   * @param headline - The headline to analyze.
   * @returns Analysis object with issues and suggestions.
   */
  static analyze(headline: string): { issues: string[]; suggestions: string[]; score: { overall: number; emotional: number; clarity: number; seo: number; wordCount: number } } {
    const score = this.score(headline);
    const issues: string[] = [];
    const suggestions: string[] = [];
    if (score.wordCount > 10) issues.push("Headline is too long (over 10 words).");
    if (score.emotional < 5) issues.push("Lacks emotional impact.");
    if (score.clarity < 50) issues.push("Low clarity due to complexity.");
    if (score.seo < 50) issues.push("Poor SEO value.");
    if (issues.length) {
      suggestions.push("Shorten headline to improve clarity.");
      suggestions.push("Add power words to boost emotional impact.");
      suggestions.push("Ensure keywords are included for SEO.");
    }
    return { issues, suggestions, score };
  }

  /**
   * Compares multiple headlines by their overall score.
   * @param headlines - Array of headlines to compare.
   * @returns Array of headlines sorted by score descending.
   */
  static compare(headlines: string[]): string[] {
    return [...headlines].sort((a, b) => this.score(b).overall - this.score(a).overall);
  }

  /**
   * Optimizes a headline by suggesting improvements.
   * @param headline - The headline to optimize.
   * @returns Improved headline suggestion.
   */
  static optimize(headline: string): string {
    const score = this.score(headline);
    const powerWords = this.powerWords();
    const missingWords = powerWords.filter(word => !headline.toLowerCase().includes(word.toLowerCase()));
    const suggestion = headline
      .split(" ")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    if (missingWords.length && score.emotional < 5) {
      return `${suggestion} — consider adding: ${missingWords.slice(0, 3).join(", ")}`;
    }
    return suggestion;
  }
}