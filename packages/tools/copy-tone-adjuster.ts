/**
 * Tone map definition for substitution rules
 */
interface ToneMap {
  from: string;
  to: string;
  substitutions: { [key: string]: string };
}

/**
 * Define tone substitution rules
 * @param from Original tone
 * @param to Target tone
 * @param substitutions Map of word/phrase replacements
 * @returns ToneMap object
 */
function defineToneMap(from: string, to: string, substitutions: { [key: string]: string }): ToneMap {
  return { from, to, substitutions };
}

/**
 * Apply tone substitutions to text
 * @param text Original text
 * @param toneMap Substitution rules
 * @returns Text with tone adjustments
 */
function adjust(text: string, toneMap: ToneMap): string {
  let result = text;
  for (const [original, replacement] of Object.entries(toneMap.substitutions)) {
    const regex = new RegExp(`\\b${original}\\b`, 'g');
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Convert formal tone to casual tone
 * @param text Formal text
 * @returns Informal version
 */
function formalToInformal(text: string): string {
  const formalToInformalMap = defineToneMap(
    'formal',
    'informal',
    {
      'utilize': 'use',
      'approximately': 'around',
      'therefore': 'so',
      'however': 'but',
      'consequently': 'so',
      'demonstrate': 'show',
      'realize': 'get',
      'implement': 'do',
      'facilitate': 'help',
      'optimize': 'improve'
    }
  );
  return adjust(text, formalToInformalMap);
}

/**
 * Convert passive voice to active voice
 * @param text Text with passive constructions
 * @returns Active voice version
 */
function activeVoice(text: string): string {
  const passiveToActiveMap = defineToneMap(
    'passive',
    'active',
    {
      'is being': 'are',
      'was being': 'were',
      'has been': 'have',
      'had been': 'had',
      'is written by': 'writes',
      'was written by': 'wrote',
      'is done by': 'does',
      'was done by': 'did'
    }
  );
  return adjust(text, passiveToActiveMap);
}

/**
 * Render side-by-side comparison of original and adjusted text
 * @param original Original text
 * @param adjusted Adjusted text
 * @returns Formatted comparison
 */
function renderDiff(original: string, adjusted: string): string {
  return `Original: ${original}\nAdjusted: ${adjusted}`;
}

export { defineToneMap, adjust, formalToInformal, activeVoice, renderDiff };