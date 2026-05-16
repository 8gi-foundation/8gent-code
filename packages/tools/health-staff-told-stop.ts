/**
 * Validates a clinical note to ensure it does not contain forbidden terms.
 * @param note - The clinical note to validate.
 * @returns An empty string if valid, or an error message if forbidden terms are found.
 */
export function validateClinicalNote(note: string): string {
  const forbiddenTerms = ["ChatGPT", "AI", "generative", "large language model"];
  for (const term of forbiddenTerms) {
    if (note.includes(term)) {
      return `Forbidden term detected: ${term}`;
    }
  }
  return "";
}