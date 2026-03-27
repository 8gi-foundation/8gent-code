/**
 * Utility for calculating osmotic pressure, tonicity, and colligative properties.
 */
export class SolutionCalculator {
  private static readonly R = 0.0821; // L·atm/(mol·K)
  private static readonly Kb = 0.512; // °C·kg/mol
  private static readonly Kf = 1.858; // °C·kg/mol

  /**
   * Calculate osmotic pressure using van 't Hoff equation.
   * @param i - van 't Hoff factor
   * @param molarity - Molarity (mol/L)
   * @param temperature - Temperature in Kelvin
   * @returns Osmotic pressure in atm
   */
  static calculateOsmoticPressure(i: number, molarity: number, temperature: number): number {
    return i * molarity * this.R * temperature;
  }

  /**
   * Calculate boiling point elevation.
   * @param i - van 't Hoff factor
   * @param molality - Molality (mol/kg)
   * @returns Boiling point elevation in °C
   */
  static calculateBoilingPointElevation(i: number, molality: number): number {
    return i * this.Kb * molality;
  }

  /**
   * Calculate freezing point depression.
   * @param i - van 't Hoff factor
   * @param molality - Molality (mol/kg)
   * @returns Freezing point depression in °C
   */
  static calculateFreezingPointDepression(i: number, molality: number): number {
    return i * this.Kf * molality;
  }

  /**
   * Calculate osmolarity from molarity and dissociation.
   * @param molarity - Molarity (mol/L)
   * @param i - van 't Hoff factor
   * @returns Osmolarity (osmol/L)
   */
  static calculateOsmolarity(molarity: number, i: number): number {
    return i * molarity;
  }

  /**
   * Classify solution tonicity based on osmolarity.
   * @param osmolarity - Osmolarity in osmol/L
   * @returns Tonicity classification
   */
  static classifyTonicity(osmolarity: number): 'isotonic' | 'hypotonic' | 'hypertonic' {
    const reference = 0.3; // osmol/L for isotonic
    if (Math.abs(osmolarity - reference) < 0.01) return 'isotonic';
    return osmolarity < reference ? 'hypotonic' : 'hypertonic';
  }
}