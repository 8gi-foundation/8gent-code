/**
 * Calculates the molecular weight of a chemical formula.
 * @param formula - The chemical formula string (e.g., 'H2O', 'Ca(OH)2').
 * @returns Molecular weight in g/mol.
 */
export function calculateMolecularWeight(formula: string): number {
  const periodicTable = {
    H: 1.008,
    He: 4.0026,
    Li: 6.94,
    Be: 9.012,
    B: 10.81,
    C: 12.01,
    N: 14.01,
    O: 16.00,
    F: 19.00,
    Ne: 20.18,
    Na: 22.99,
    Mg: 24.31,
    Al: 26.98,
    Si: 28.09,
    P: 30.97,
    S: 32.07,
    Cl: 35.45,
    Ar: 39.95,
    K: 39.10,
    Ca: 40.08,
    Fe: 55.85,
    Cu: 63.55,
    Zn: 65.38,
    Br: 79.90,
    I: 126.90,
    Ag: 107.87,
    Sn: 118.71,
    Pb: 207.2,
    Hg: 200.59,
    Au: 196.97,
  };

  let stack: { [key: string]: number }[] = [];
  let current: { [key: string]: number } = {};
  let i = 0;

  while (i < formula.length) {
    const char = formula[i];

    if (char === '(') {
      stack.push(current);
      current = {};
      i++;
    } else if (char === ')') {
      let numStr = '';
      i++;
      while (i < formula.length && /\d/.test(formula[i])) {
        numStr += formula[i++];
      }
      const multiplier = numStr ? parseInt(numStr, 10) : 1;

      const prev = stack.pop()!;
      for (const [element, count] of Object.entries(current)) {
        prev[element] = (prev[element] || 0) + count * multiplier;
      }
      current = prev;
    } else if (/[A-Z]/.test(char)) {
      let element = char;
      if (i + 1 < formula.length && /[a-z]/.test(formula[i + 1])) {
        element += formula[++i];
      }
      i++;

      let numStr = '';
      while (i < formula.length && /\d/.test(formula[i])) {
        numStr += formula[i++];
      }
      const count = numStr ? parseInt(numStr, 10) : 1;

      current[element] = (current[element] || 0) + count;
    } else {
      i++;
    }
  }

  let weight = 0;
  for (const [element, count] of Object.entries(current)) {
    weight += periodicTable[element]! * count;
  }
  return weight;
}