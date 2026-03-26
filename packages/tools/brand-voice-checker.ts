/**
 * Defines a brand voice profile.
 * @param config - Configuration object with traits, avoidWords, preferWords, and sentenceLength.
 * @returns The defined voice profile.
 */
interface Voice {
  traits: string[];
  avoidWords: string[];
  preferWords: string[];
  sentenceLength: number;
}

/**
 * Analysis result containing score, violations, and suggestions.
 */
interface AnalysisResult {
  score: number;
  violations: Array<{
    type: 'avoidWord' | 'sentenceLength' | 'preferWord';
    word?: string;
    sentence?: string;
    message: string;
  }>;
  suggestions: string[];
}

/**
 * Defines a brand voice profile.
 * @param config - Configuration object with traits, avoidWords, preferWords, and sentenceLength.
 * @returns The defined voice profile.
 */
function defineVoice(config: { traits: string[]; avoidWords: string[]; preferWords: string[]; sentenceLength: number }): Voice {
  return {
    traits: config.traits,
    avoidWords: config.avoidWords,
    preferWords: config.preferWords,
    sentenceLength: config.sentenceLength,
  };
}

/**
 * Analyzes text against a defined voice profile.
 * @param voice - The voice profile to check against.
 * @param text - The text to analyze.
 * @returns Analysis results including score, violations, and suggestions.
 */
function analyzeText(voice: Voice, text: string): AnalysisResult {
  const violations: Array<{
    type: 'avoidWord' | 'sentenceLength' | 'preferWord';
    word?: string;
    sentence?: string;
    message: string;
  }> = [];
  const suggestions: string[] = [];

  // Check for avoid words
  const words = text.split(/\s+/);
  for (const word of words) {
    if (voice.avoidWords.includes(word)) {
      violations.push({
        type: 'avoidWord',
        word,
        message: `Avoid word: "${word}"`,
      });
    }
  }

  // Check for sentence length
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  for (const sentence of sentences) {
    if (sentence.length > voice.sentenceLength) {
      violations.push({
        type: 'sentenceLength',
        sentence,
        message: `Sentence too long: "${sentence}" (length: ${sentence.length})`,
      });
    }
  }

  // Check for preferred words
  const hasPreferWord = voice.preferWords.some(word => text.includes(word));
  if (!hasPreferWord) {
    suggestions.push(`Consider using preferred words: ${voice.preferWords.join(', ')}`);
  }

  // Calculate score based on violations
  const score = Math.max(100 - violations.length * 10, 0);

  return {
    score,
    violations,
    suggestions,
  };
}

/**
 * Calculates the Flesch-Kincaid readability grade level.
 * @param text - The text to analyze.
 * @returns The readability score.
 */
function scoreReadability(text: string): number {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.split(/\s+/);
  const syllables = words.reduce((sum, word) => sum + ((word.match(/[aeiouy]/gi) || []).length), 0);

  if (sentences.length === 0 || words.length === 0) {
    return 0;
  }

  const avgWordsPerSentence = words.length / sentences.length;
  const avgSyllablesPerWord = syllables / words.length;

  return 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
}

/**
 * Highlights violations in the text with markers.
 * @param voice - The voice profile to check against.
 * @param text - The text to analyze.
 * @returns The text with violations marked.
 */
function highlightViolations(voice: Voice, text: string): string {
  let result = text;
  const words = text.split(/\s+/);

  for (const word of words) {
    if (voice.avoidWords.includes(word)) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), `**${word}**`);
    }
  }

  return result;
}

export { defineVoice, analyzeText, scoreReadability, highlightViolations };