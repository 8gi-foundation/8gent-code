/**
 * Calculate orbital transfer requirements.
 */
export class OrbitalTransferCalculator {
  /**
   * Calculate Hohmann and bi-elliptic transfer requirements.
   * @param r1 Initial orbit radius
   * @param r2 Target orbit radius
   * @param mu Gravitational parameter
   * @returns Object with hohmann and biElliptic results
   */
  static calculate(r1: number, r2: number, mu: number): {
    hohmann: {deltaV: number, transferTime: number},
    biElliptic: {deltaV: number, transferTime: number}
  } {
    const hohmann = {
      deltaV: Math.sqrt(mu) * (
        Math.sqrt(2 * r2 / (r1 * (r1 + r2))) - 1 +
        1 - Math.sqrt(2 * r1 / (r2 * (r1 + r2)))
      ),
      transferTime: (Math.PI / Math.sqrt(mu)) * Math.pow((r1 + r2) / 2, 3/2)
    };

    const r3 = Math.sqrt(r1 * r2);
    const biEllipticDeltaV = Math.sqrt(mu) * (
      Math.sqrt(2 * r3 / (r1 * (r1 + r3))) - 1 +
      Math.sqrt(2 * r2 / (r3 * (r3 + r2))) - 1 +
      1 - Math.sqrt(2 * r1 / (r3 * (r1 + r3)))
    );

    const semiMajorAxis1 = (r1 + r3) / 2;
    const semiMajorAxis2 = (r3 + r2) / 2;
    const biEllipticTransferTime = (
      (Math.PI / Math.sqrt(mu)) * Math.pow(semiMajorAxis1, 3/2) +
      (Math.PI / Math.sqrt(mu)) * Math.pow(semiMajorAxis2, 3/2)
    );

    return {
      hohmann,
      biElliptic: {deltaV: biEllipticDeltaV, transferTime: biEllipticTransferTime}
    };
  }
}