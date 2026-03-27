/**
 * Utility class for converting stellar parallax and proper motion to distance and velocity.
 */
export class ParallaxConverter {
  /**
   * Convert parallax to distance in parsecs, light-years, and astronomical units.
   * @param parallax - Parallax value
   * @param unit - Unit of parallax: 'arcsec', 'mas', or 'μas'
   * @returns Object with distance in pc, ly, and au
   */
  static convertParallax(parallax: number, unit: 'arcsec' | 'mas' | 'μas'): { pc: number; ly: number; au: number } {
    let arcsec = parallax;
    if (unit === 'mas') arcsec /= 1000;
    if (unit === 'μas') arcsec /= 1e6;
    const pc = 1 / arcsec;
    return {
      pc,
      ly: pc * 3.262,
      au: pc * 206264.8,
    };
  }

  /**
   * Convert proper motion to transverse velocity in km/s.
   * @param pm - Proper motion in arcsec/yr
   * @param distancePc - Distance in parsecs
   * @returns Transverse velocity in km/s
   */
  static convertProperMotion(pm: number, distancePc: number): number {
    return pm * distancePc * 4.74;
  }
}