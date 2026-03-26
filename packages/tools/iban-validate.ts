/**
 * Normalize IBAN by removing spaces and uppercasing.
 * @param iban - The IBAN to normalize.
 * @returns Normalized IBAN.
 */
export function normalize(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * Extract the 2-letter country code from an IBAN.
 * @param iban - The IBAN to extract the country code from.
 * @returns 2-letter country code.
 */
export function extractCountry(iban: string): string {
  return iban.substring(0, 2);
}

/**
 * Convert a character to its numeric value for IBAN mod97 calculation.
 * @param c - Character to convert.
 * @returns Numeric value.
 */
function charToValue(c: string): number {
  if (c >= '0' && c <= '9') return parseInt(c, 10);
  if (c >= 'A' && c <= 'Z') return 10 + (c.charCodeAt(0) - 'A'.charCodeAt(0));
  throw new Error('Invalid character in IBAN');
}

/**
 * Perform IBAN mod97 checksum calculation.
 * @param iban - The IBAN to calculate.
 * @returns Mod97 result.
 */
export function mod97(iban: string): number {
  let total = 0;
  const rearranged = iban.substring(4) + iban.substring(0, 4);
  for (const c of rearranged) {
    total = (total * 10 + charToValue(c)) % 97;
  }
  return total;
}

/**
 * Validate an IBAN against EU standards.
 * @param iban - The IBAN to validate.
 * @returns Validation result with ok flag and optional reason.
 */
export function validate(iban: string): { ok: boolean; reason?: string } {
  const normalized = normalize(iban);
  const country = extractCountry(normalized);
  const length = normalized.length;
  const expectedLength = ibanLengths[country];
  if (!expectedLength) {
    return { ok: false, reason: 'Unsupported country code' };
  }
  if (length !== expectedLength) {
    return { ok: false, reason: 'Invalid length for country' };
  }
  const modResult = mod97(normalized);
  if (modResult !== 1) {
    return { ok: false, reason: 'Checksum failed' };
  }
  return { ok: true };
}

const ibanLengths = {
  AT: 20, BE: 16, BG: 22, HR: 21, CY: 28, CZ: 24, DK: 18, EE: 20, FI: 18, FR: 27,
  DE: 22, GR: 27, HU: 28, IE: 22, IT: 27, LV: 21, LT: 20, LU: 20, MT: 31, NL: 18,
  PL: 28, PT: 25, RO: 24, SK: 24, SI: 19, ES: 24, SE: 24, GB: 22,
};