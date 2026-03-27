/**
 * Calculate observed frequency due to Doppler effect.
 * @param sourceFrequency - Source frequency in Hz
 * @param sourceVelocity - Source velocity in m/s (positive if moving away)
 * @param observerVelocity - Observer velocity in m/s (positive if moving toward)
 * @param mediumSpeed - Speed of medium (for sound, optional)
 * @param mode - 'sound' or 'light'
 * @returns {observed: number, ratio: number}
 */
export function calculateDoppler(
  sourceFrequency: number,
  sourceVelocity: number,
  observerVelocity: number,
  mediumSpeed?: number,
  mode: 'sound' | 'light' = 'sound'
): { observed: number; ratio: number } {
  const c = 299792458; // Speed of light in m/s
  let observed: number;

  if (mode === 'sound') {
    if (mediumSpeed === undefined) {
      throw new Error('mediumSpeed required for sound mode');
    }
    const denominator = mediumSpeed - sourceVelocity;
    if (denominator <= 0) {
      observed = NaN;
    } else {
      observed =
        sourceFrequency *
        (mediumSpeed + observerVelocity) /
        denominator;
    }
  } else {
    const beta = sourceVelocity / c;
    const denominator = Math.sqrt(1 - beta ** 2);
    if (isNaN(denominator)) {
      observed = NaN;
    } else {
      observed =
        sourceFrequency *
        (1 + observerVelocity / c) /
        denominator;
    }
  }

  return { observed, ratio: observed / sourceFrequency };
}