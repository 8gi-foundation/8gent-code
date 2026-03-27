/**
 * Calculate GC content percentage.
 * @param seq DNA sequence
 * @returns GC% (G+C)/total * 100
 */
export function calculateGCContent(seq: string): number {
  const total = seq.length;
  const gcCount = (seq.match(/[GC]/g) || []).length;
  return (gcCount / total) * 100;
}

/**
 * Calculate AT/GC ratio.
 * @param seq DNA sequence
 * @returns (A+T)/(G+C)
 */
export function calculateATGC(seq: string): number {
  const atCount = (seq.match(/[AT]/g) || []).length;
  const gcCount = (seq.match(/[GC]/g) || []).length;
  return gcCount === 0 ? 0 : atCount / gcCount;
}

/**
 * Calculate melting temperature using Wallace rule.
 * @param seq DNA sequence
 * @returns Melting temperature in Celsius
 */
export function calculateMeltingTemp(seq: string): number {
  const gcCount = (seq.match(/[GC]/g) || []).length;
  const atCount = (seq.match(/[AT]/g) || []).length;
  return 4 * gcCount + 2 * atCount;
}

/**
 * Calculate linguistic complexity.
 * @param seq DNA sequence
 * @returns Vocabulary / max-vocabulary (0-1)
 */
export function calculateLinguisticComplexity(seq: string): number {
  const dinucleotides = new Set<string>();
  for (let i = 0; i < seq.length - 1; i++) {
    dinucleotides.add(seq[i] + seq[i + 1]);
  }
  const vocab = dinucleotides.size;
  const maxVocab = 16; // 4^2 possible dinucleotides
  return vocab / maxVocab;
}

/**
 * Get dinucleotide frequency table.
 * @param seq DNA sequence
 * @returns Map of dinucleotides to counts
 */
export function getDinucleotideFrequencies(seq: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (let i = 0; i < seq.length - 1; i++) {
    const dinuc = seq[i] + seq[i + 1];
    freq.set(dinuc, (freq.get(dinuc) || 0) + 1);
  }
  return freq;
}