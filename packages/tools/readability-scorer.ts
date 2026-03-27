/**
 * Calculates Flesch Reading Ease score (0-100)
 * @param text - Input text to analyze
 * @returns Flesch Reading Ease score
 */
export function fleschEase(text: string): number {
  const { words, sentences, syllables } = getStats(text);
  if (sentences === 0 || words === 0) return 0;
  const avgWordsPerSentence = words / sentences;
  const avgSyllablesPerWord = syllables / words;
  return 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
}

/**
 * Calculates Flesch-Kincaid Grade Level
 * @param text - Input text to analyze
 * @returns Grade level (e.g. 8.5 = 8th grade)
 */
export function fleschKincaidGrade(text: string): number {
  const { words, sentences, syllables } = getStats(text);
  if (sentences === 0 || words === 0) return 0;
  const avgWordsPerSentence = words / sentences;
  const avgSyllablesPerWord = syllables / words;
  return 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
}

/**
 * Calculates Gunning Fog index
 * @param text - Input text to analyze
 * @returns Gunning Fog index
 */
export function gunningFog(text: string): number {
  const { words, sentences, complexWords } = getStats(text);
  if (sentences === 0 || words === 0) return 0;
  const avgWordsPerSentence = words / sentences;
  const percentComplexWords = complexWords / words;
  return 0.4 * (avgWordsPerSentence + percentComplexWords);
}

/**
 * Analyzes text with all readability metrics
 * @param text - Input text to analyze
 * @returns All metrics with descriptive labels
 */
export function analyze(text: string): {
  fleschEase: number;
  fleschGrade: number;
  gunningFog: number;
  labels: {
    fleschEase: string;
    fleschGrade: string;
    gunningFog: string;
  };
} {
  const ease = fleschEase(text);
  const grade = fleschKincaidGrade(text);
  const fog = gunningFog(text);

  const easeLabel = ease >= 90 ? 'Very Easy' : ease >= 60 ? 'Easy' : ease >= 40 ? 'Moderate' : ease >= 30 ? 'Difficult' : 'Very Difficult';
  const gradeLabel = grade < 5 ? 'Elementary' : grade < 7 ? 'Middle School' : grade < 9 ? 'High School' : grade < 12 ? 'College' : 'Graduate';
  const fogLabel = fog < 6 ? 'Easy' : fog < 10 ? 'Moderate' : 'Difficult';

  return { fleschEase: ease, fleschGrade: grade, gunningFog: fog, labels: { fleschEase: easeLabel, fleschGrade: gradeLabel, gunningFog: fogLabel } };
}

/**
 * Provides actionable improvement suggestions
 * @param text - Input text to analyze
 * @returns Array of improvement tips
 */
export function suggestions(text: string): string[] {
  const { fleschEase: ease, fleschGrade: grade } = analyze(text);
  const tips: string[] = [];

  if (ease < 30) {
    tips.push('Use simpler vocabulary and shorter sentences.');
    tips.push('Avoid complex terms and jargon.');
  }
  if (grade > 12) {
    tips.push('Break down long sentences into shorter ones.');
    tips.push('Use more common words and active voice.');
  }
  if (ease >= 60 && grade < 5) {
    tips.push('Consider adding more complex vocabulary for depth.');
  }
  return tips;
}

function getStats(text: string): { words: number; sentences: number; syllables: number; complexWords: number } {
  const words = text.match(/\b\w+\b/g) || [];
  const sentences = text.match(/[^\.!\?]+[\.!\?]+/g) || [];
  let syllables = 0;
  let complexWords = 0;

  for (const word of words) {
    const vowels = word.match(/[aeiouy]/gi) || [];
    syllables += vowels.length;
    if (vowels.length >= 3) complexWords++;
  }

  return { words: words.length, sentences: sentences.length, syllables, complexWords };
}