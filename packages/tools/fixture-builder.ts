/**
 * Creates a new FixtureBuilder with the given defaults.
 * @param defaults - The default values for the fixture.
 * @returns A new FixtureBuilder instance.
 */
export function defineFixture<T>(defaults: T): FixtureBuilder<T> {
  return new FixtureBuilder(defaults);
}

/**
 * A builder for creating test fixture objects.
 */
export class FixtureBuilder<T> {
  /**
   * Creates a fixture object by merging the defaults with the given overrides.
   * @param overrides - Optional overrides for the fixture.
   * @returns The built fixture object.
   */
  build(overrides?: Partial<T>): T {
    return merge(this.defaults, overrides);
  }

  /**
   * Creates multiple fixture objects by merging the defaults with the given overrides.
   * @param count - The number of fixtures to create.
   * @param overrides - Optional overrides for the fixtures.
   * @returns An array of built fixture objects.
   */
  buildMany(count: number, overrides?: Partial<T>): T[] {
    return Array.from({ length: count }, () => this.build(overrides));
  }

  private constructor(private defaults: T) {}
}

function merge<T>(a: T, b: Partial<T>): T {
  if (b === undefined) return a;
  if (typeof a !== 'object' || a === null) return { ...a, ...b };
  if (Array.isArray(a)) return [...a, ...(b as any)];
  const result = { ...a, ...b };
  for (const key in result) {
    if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], (b as any)[key]);
    }
  }
  return result;
}