/**
 * Converts a value from one unit to another.
 * @param value The numerical value to convert.
 * @param from The unit to convert from (e.g., 'm', 'kg', 'C').
 * @param to The unit to convert to (e.g., 'km', 'lb', 'F').
 * @returns The converted value.
 * @throws Error if units are not in the same category or conversion is unsupported.
 */
export function convert(value: number, from: string, to: string): number {
  const unitCategory = {
    m: 'length', km: 'length', ft: 'length', in: 'length', mi: 'length',
    kg: 'mass', g: 'mass', lb: 'mass', oz: 'mass',
    l: 'volume', ml: 'volume', gal: 'volume', 'fl oz': 'volume',
    'km/h': 'speed', 'mph': 'speed', 'm/s': 'speed',
    C: 'temp', F: 'temp', K: 'temp'
  };

  const conversions = {
    length: { m: 1, km: 1000, ft: 0.3048, in: 0.0254, mi: 1609.34 },
    mass: { kg: 1, g: 0.001, lb: 0.453592, oz: 0.0283495 },
    volume: { l: 1, ml: 0.001, gal: 3.78541, 'fl oz': 0.0295735 },
    speed: { 'km/h': 1, 'mph': 0.44704, 'm/s': 0.277778 }
  };

  const fromCategory = unitCategory[from];
  const toCategory = unitCategory[to];
  if (fromCategory !== toCategory) {
    throw new Error('Units must be in the same category');
  }

  if (fromCategory === 'temp') {
    switch (`${from}-${to}`) {
      case 'C-F':
        return (value * 9 / 5) + 32;
      case 'F-C':
        return (value - 32) * 5 / 9;
      case 'C-K':
        return value + 273.15;
      case 'K-C':
        return value - 273.15;
      case 'F-K':
        return (value - 32) * 5 / 9 + 273.15;
      case 'K-F':
        return (value - 273.15) * 9 / 5 + 32;
      default:
        throw new Error('Unsupported temperature conversion');
    }
  }

  const fromFactor = conversions[fromCategory][from];
  const toFactor = conversions[fromCategory][to];
  return value * (fromFactor / toFactor);
}