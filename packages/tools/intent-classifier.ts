/**
 * Classifies user messages based on keywords and patterns.
 */
interface Classifier {
  intents: Array<{
    name: string;
    keywords: string[];
    patterns: RegExp[];
    priority: number;
  }>;
  defaultIntent: string | null;
}

/**
 * Adds an intent to the classifier.
 * @param classifier - The classifier object.
 * @param config - Intent configuration.
 */
function addIntent(classifier: Classifier, config: { name: string; keywords: string[]; patterns: string[]; priority: number }): void {
  const { name, keywords, patterns, priority } = config;
  classifier.intents.push({
    name,
    keywords,
    patterns: patterns.map(p => new RegExp(p)),
    priority,
  });
}

/**
 * Classifies text to the best matching intent.
 * @param classifier - The classifier object.
 * @param text - Input text.
 * @returns Best matching intent with score or null.
 */
function classify(classifier: Classifier, text: string): { name: string; score: number } | null {
  let bestScore = -1;
  let bestIntent = null;

  for (const intent of classifier.intents) {
    let score = 0;
    let keywordMatches = 0;
    for (const keyword of intent.keywords) {
      if (text.includes(keyword)) keywordMatches++;
    }
    let patternMatches = 0;
    for (const pattern of intent.patterns) {
      if (pattern.test(text)) patternMatches++;
    }
    score = (keywordMatches + patternMatches) * intent.priority;

    if (score > bestScore) {
      bestScore = score;
      bestIntent = { name: intent.name, score: bestScore };
    }
  }

  if (bestIntent && bestScore > 0) return bestIntent;
  if (classifier.defaultIntent) return { name: classifier.defaultIntent, score: 0 };
  return null;
}

/**
 * Classifies text to all matching intents.
 * @param classifier - The classifier object.
 * @param text - Input text.
 * @returns Array of matching intents sorted by score.
 */
function classifyAll(classifier: Classifier, text: string): Array<{ name: string; score: number }> {
  const matches: Array<{ name: string; score: number }> = [];

  for (const intent of classifier.intents) {
    let score = 0;
    let keywordMatches = 0;
    for (const keyword of intent.keywords) {
      if (text.includes(keyword)) keywordMatches++;
    }
    let patternMatches = 0;
    for (const pattern of intent.patterns) {
      if (pattern.test(text)) patternMatches++;
    }
    score = (keywordMatches + patternMatches) * intent.priority;

    if (score > 0) matches.push({ name: intent.name, score });
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Sets the default intent for the classifier.
 * @param classifier - The classifier object.
 * @param fallback - Default intent name.
 */
function defaultIntent(classifier: Classifier, fallback: string): void {
  classifier.defaultIntent = fallback;
}

/**
 * Renders the classifier's intents as a table.
 * @param classifier - The classifier object.
 */
function renderClassifier(classifier: Classifier): void {
  console.log("Intent\tKeywords\tPatterns\tPriority");
  for (const intent of classifier.intents) {
    console.log(
      `${intent.name}\t${intent.keywords.join(", ")}\t${intent.patterns.map(p => p.source).join(", ")}\t${intent.priority}`
    );
  }
}

export { addIntent, classify, classifyAll, defaultIntent, renderClassifier };