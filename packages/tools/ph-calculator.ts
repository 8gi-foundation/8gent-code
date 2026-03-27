/**
 * Converts pH to pOH, [H+], and [OH-]
 * @param pH - The pH value
 * @returns Object containing pOH, [H+], and [OH-]
 */
export function fromPH(pH: number): { pOH: number; h: number; oh: number } {
  const pOH = 14 - pH;
  const h = 10 ** (-pH);
  const oh = 10 ** (-pOH);
  return { pOH, h, oh };
}

/**
 * Converts pOH to pH, [H+], and [OH-]
 * @param pOH - The pOH value
 * @returns Object containing pH, [H+], and [OH-]
 */
export function fromPOH(pOH: number): { pH: number; h: number; oh: number } {
  const pH = 14 - pOH;
  const h = 10 ** (-pH);
  const oh = 10 ** (-pOH);
  return { pH, h, oh };
}

/**
 * Converts [H+] to pH, pOH, and [OH-]
 * @param h - The [H+] concentration
 * @returns Object containing pH, pOH, and [OH-]
 */
export function fromH(h: number): { pH: number; pOH: number; oh: number } {
  const pH = -Math.log10(h);
  const { pOH, oh } = fromPH(pH);
  return { pH, pOH, oh };
}

/**
 * Converts [OH-] to pH, pOH, and [H+]
 * @param oh - The [OH-] concentration
 * @returns Object containing pH, pOH, and [H+]
 */
export function fromOH(oh: number): { pH: number; pOH: number; h: number } {
  const pOH = -Math.log10(oh);
  const { pH, h } = fromPOH(pOH);
  return { pH, pOH, h };
}

/**
 * Calculates pH, pOH, [H+], and [OH-] for a strong acid
 * @param concentration - The concentration of the strong acid
 * @returns Object containing pH, pOH, [H+], and [OH-]
 */
export function calculateStrongAcid(concentration: number): { pH: number; pOH: number; h: number; oh: number } {
  const h = concentration;
  return { ...fromH(h) };
}

/**
 * Calculates pH, pOH, [H+], and [OH-] for a strong base
 * @param concentration - The concentration of the strong base
 * @returns Object containing pH, pOH, [H+], and [OH-]
 */
export function calculateStrongBase(concentration: number): { pH: number; pOH: number; h: number; oh: number } {
  const oh = concentration;
  return { ...fromOH(oh) };
}

/**
 * Calculates pH, pOH, [H+], and [OH-] for a weak acid using Ka
 * @param concentration - The concentration of the weak acid
 * @param ka - The acid dissociation constant
 * @returns Object containing pH, pOH, [H+], and [OH-]
 */
export function calculateWeakAcid(concentration: number, ka: number): { pH: number; pOH: number; h: number; oh: number } {
  const sqrt = Math.sqrt(ka ** 2 + 4 * ka * concentration);
  const h = (-ka + sqrt) / 2;
  return { ...fromH(h) };
}

/**
 * Calculates pH, pOH, [H+], and [OH-] for a buffer solution
 * @param pKa - The pKa of the buffer
 * @param baseConcentration - The concentration of the base component
 * @param acidConcentration - The concentration of the acid component
 * @returns Object containing pH, pOH, [H+], and [OH-]
 */
export function calculateBuffer(pKa: number, baseConcentration: number, acidConcentration: number): { pH: number; pOH: number; h: number; oh: number } {
  const pH = pKa + Math.log10(baseConcentration / acidConcentration);
  return { ...fromPH(pH) };
}