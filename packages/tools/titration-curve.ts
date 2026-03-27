/**
 * Generate titration curve data for strong acid + strong base
 * @param volumeAcid - mL of acid
 * @param concAcid - Molarity of acid
 * @param concBase - Molarity of base
 * @returns {dataPoints: {volumeAdded: number, pH: number}[], equivalence: {volume: number, pH: number}}
 */
export function strongStrongTitration(volumeAcid: number, concAcid: number, concBase: number): {dataPoints: {volumeAdded: number, pH: number}[], equivalence: {volume: number, pH: number}} {
  const molesAcid = volumeAcid * concAcid / 1000
  const equivVol = (molesAcid / concBase) * 1000
  const points = []
  for (let v = 0; v <= equivVol; v += 1) {
    const molesBase = v * concBase / 1000
    const excess = molesAcid - molesBase
    const concH = excess * 1000 / (volumeAcid + v)
    points.push({volumeAdded: v, pH: -Math.log10(concH)})
  }
  return {dataPoints: points, equivalence: {volume: equivVol, pH: 7}}
}

/**
 * Generate titration curve data for weak acid + strong base
 * @param volumeAcid - mL of weak acid
 * @param concAcid - Molarity of weak acid
 * @param pKa - Dissociation constant of weak acid
 * @param concBase - Molarity of base
 * @returns {dataPoints: {volumeAdded: number, pH: number}[], equivalence: {volume: number, pH: number}}
 */
export function weakStrongTitration(volumeAcid: number, concAcid: number, pKa: number, concBase: number): {dataPoints: {volumeAdded: number, pH: number}[], equivalence: {volume: number, pH: number}} {
  const molesAcid = volumeAcid * concAcid / 1000
  const equivVol = (molesAcid / concBase) * 1000
  const points = []
  for (let v = 0; v <= equivVol; v += 1) {
    const molesBase = v * concBase / 1000
    const molesAcidRemaining = molesAcid - molesBase
    const molesConjBase = molesBase
    if (v < equivVol) {
      const ratio = molesConjBase / molesAcidRemaining
      points.push({volumeAdded: v, pH: pKa + Math.log10(ratio)})
    } else {
      const concConjBase = molesConjBase * 1000 / (volumeAcid + v)
      const kb = 1e-14 / Math.pow(10, pKa)
      const concOH = Math.sqrt(kb * concConjBase)
      points.push({volumeAdded: v, pH: 14 + Math.log10(concOH)})
    }
  }
  return {dataPoints: points, equivalence: {volume: equivVol, pH: 14 - pKa/2}}
}

/**
 * Generate titration curve data for polyprotic acid + strong base
 * @param volumeAcid - mL of polyprotic acid
 * @param concAcid - Molarity of acid
 * @param pKa - Array of dissociation constants
 * @param concBase - Molarity of base
 * @returns {dataPoints: {volumeAdded: number, pH: number}[], equivalence: {volume: number, pH: number}}
 */
export function polyproticTitration(volumeAcid: number, concAcid: number, pKa: number[], concBase: number): {dataPoints: {volumeAdded: number, pH: number}[], equivalence: {volume: number, pH: number}} {
  const molesAcid = volumeAcid * concAcid / 1000
  const equivVol = (molesAcid / concBase) * 1000 / pKa.length
  const points = []
  for (let v = 0; v <= equivVol; v += 1) {
    const molesBase = v * concBase / 1000
    const molesAcidRemaining = molesAcid - molesBase * pKa.length
    const ratio = molesBase / molesAcidRemaining
    points.push({volumeAdded: v, pH: pKa[0] + Math.log10(ratio)})
  }
  return {dataPoints: points, equivalence: {volume: equivVol, pH: (pKa[0] + pKa[1])/2}}
}