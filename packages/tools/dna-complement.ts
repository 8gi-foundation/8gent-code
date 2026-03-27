/**
 * Generate DNA complement.
 * @param sequence - DNA sequence
 * @returns Complementary sequence
 */
export function generateComplement(sequence: string): string {
  return sequence.split('').map(c => ({
    A: 'T',
    T: 'A',
    G: 'C',
    C: 'G'
  }[c] || c)).join('');
}

/**
 * Generate reverse complement of DNA sequence.
 * @param sequence - DNA sequence
 * @returns Reverse complementary sequence
 */
export function generateReverseComplement(sequence: string): string {
  return generateComplement(sequence).split('').reverse().join('');
}

/**
 * Transcribe DNA to mRNA.
 * @param sequence - DNA sequence
 * @returns mRNA transcript
 */
export function generateTranscript(sequence: string): string {
  return sequence.split('').map(c => ({
    T: 'U'
  }[c] || c)).join('');
}

/**
 * Calculate GC content percentage.
 * @param sequence - DNA sequence
 * @returns GC content percentage
 */
export function calculateGCContent(sequence: string): number {
  const gcCount = sequence.split('').filter(c => 'GC'.includes(c)).length;
  return (gcCount / sequence.length) * 100;
}