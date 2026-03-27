/**
 * Compute the union of two arrays.
 * @param a First array
 * @param b Second array
 * @returns Union of a and b
 */
export function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}

/**
 * Compute the intersection of two arrays.
 * @param a First array
 * @param b Second array
 * @returns Elements common to both arrays
 */
export function intersection<T>(a: T[], b: T[]): T[] {
  return a.filter(x => new Set(b).has(x));
}

/**
 * Compute the difference between two arrays.
 * @param a First array
 * @param b Second array
 * @returns Elements in a not in b
 */
export function difference<T>(a: T[], b: T[]): T[] {
  return a.filter(x => !new Set(b).has(x));
}

/**
 * Compute the symmetric difference of two arrays.
 * @param a First array
 * @param b Second array
 * @returns Elements in either a or b but not in both
 */
export function symmetricDifference<T>(a: T[], b: T[]): T[] {
  return union(difference(a, b), difference(b, a));
}

/**
 * Generate the power set of an array.
 * @param arr Input array
 * @returns Array of all subsets
 */
export function powerSet<T>(arr: T[]): T[][] {
  if (arr.length === 0) return [[]];
  const [head, ...tail] = arr;
  const subsets = powerSet(tail);
  return subsets.concat(subsets.map(subset => [...subset, head]));
}

/**
 * Compute the Cartesian product of two arrays.
 * @param a First array
 * @param b Second array
 * @returns Array of tuples representing the product
 */
export function cartesianProduct<T>(a: T[], b: T[]): [T, T][] {
  return a.flatMap(x => b.map(y => [x, y] as const));
}

/**
 * Check if a is a subset of b.
 * @param a Potential subset
 * @param b Superset
 * @returns True if all elements of a are in b
 */
export function isSubset<T>(a: T[], b: T[]): boolean {
  return a.every(x => b.includes(x));
}

/**
 * Check if a is a superset of b.
 * @param a Potential superset
 * @param b Subset
 * @returns True if all elements of b are in a
 */
export function isSuperset<T>(a: T[], b: T[]): boolean {
  return isSubset(b, a);
}

/**
 * Check if an element is present in the array.
 * @param a Array to check
 * @param element Element to look for
 * @returns True if element is in a
 */
export function hasElement<T>(a: T[], element: T): boolean {
  return a.includes(element);
}