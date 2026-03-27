/**
 * Calculates oxidation states for elements in compounds using electronegativity rules.
 */
export class OxidationStateCalculator {
  private commonIons: { [key: string]: number } = {
    'OH-': -1,
    'ClO4-': -1,
    'SO4^2-': -2,
    'NO3-': -1,
    'CO3^2-': -2,
    'PO4^3-': -3,
  };

  /**
   * Determines oxidation states for each element in a compound.
   * @param formula - Chemical formula (e.g., 'H2O', 'FeCl3')
   * @param charge - Overall charge of the compound (0 for neutral)
   * @returns Map of elements to their oxidation states
   */
  public calculate(formula: string, charge: number): { [element: string]: number } {
    const elements = this.parseFormula(formula);
    const result: { [element: string]: number } = {};
    let totalKnown = 0;

    for (const element in elements) {
      let oxState = 0;
      if (element === 'O') oxState = -2;
      else if (element === 'H') oxState = +1;
      else if (element in this.commonIons) oxState = this.commonIons[element];
      else {
        oxState = (charge - totalKnown) / elements[element];
      }
      result[element] = oxState;
      totalKnown += oxState * elements[element];
    }

    return result;
  }

  /**
   * Parses a chemical formula into a map of element counts.
   * @param formula - Chemical formula (e.g., 'H2O', 'FeCl3')
   * @returns Map of element symbols to their counts
   */
  private parseFormula(formula: string): { [element: string]: number } {
    const result: { [element: string]: number } = {};
    let i = 0;

    while (i < formula.length) {
      const char = formula[i];
      if (/[A-Z]/.test(char)) {
        let element = char;
        i++;
        if (/[0-9]/.test(formula[i])) {
          element += formula[i];
          i++;
        }
        result[element] = (result[element] || 0) + 1;
      } else {
        i++;
      }
    }

    return result;
  }
}