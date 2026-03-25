/**
 * test-fixture-builder
 *
 * Builds test fixtures using a factory pattern with traits, sequences,
 * and associations for consistent, composable test data generation.
 */

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type Defaults<T> = {
  [K in keyof T]: T[K] | (() => T[K]);
};

type Trait<T> = DeepPartial<T> | ((base: T) => DeepPartial<T>);

interface FactoryOptions<T> {
  name: string;
  defaults: Defaults<T>;
  traits?: Record<string, Trait<T>>;
}

const sequences: Record<string, number> = {};

function nextSeq(key: string): number {
  sequences[key] = (sequences[key] ?? 0) + 1;
  return sequences[key];
}

function resolveDefaults<T>(defaults: Defaults<T>): T {
  const result = {} as T;
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const val = defaults[key];
    (result as Record<keyof T, unknown>)[key] =
      typeof val === "function" ? (val as () => T[keyof T])() : val;
  }
  return result;
}

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override) as Array<keyof T>) {
    const ov = override[key];
    const bv = base[key as keyof T];
    if (
      ov !== null &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      bv !== null &&
      typeof bv === "object" &&
      !Array.isArray(bv)
    ) {
      result[key as string] = deepMerge(bv, ov as DeepPartial<typeof bv>);
    } else if (ov !== undefined) {
      result[key as string] = ov;
    }
  }
  return result as T;
}

export class Factory<T extends object> {
  readonly name: string;
  private readonly defaults: Defaults<T>;
  private readonly traitMap: Record<string, Trait<T>>;

  constructor(options: FactoryOptions<T>) {
    this.name = options.name;
    this.defaults = options.defaults;
    this.traitMap = options.traits ?? {};
  }

  build(overrides?: DeepPartial<T>, ...traitNames: string[]): T {
    let base = resolveDefaults(this.defaults);
    for (const traitName of traitNames) {
      const trait = this.traitMap[traitName];
      if (!trait) throw new Error(`Unknown trait "${traitName}" on factory "${this.name}"`);
      const patch = typeof trait === "function" ? trait(base) : trait;
      base = deepMerge(base, patch);
    }
    if (overrides) base = deepMerge(base, overrides);
    return base;
  }

  buildList(count: number, overrides?: DeepPartial<T>, ...traitNames: string[]): T[] {
    return Array.from({ length: count }, () => this.build(overrides, ...traitNames));
  }

  seq(): number {
    return nextSeq(this.name);
  }

  association<A extends object>(factory: Factory<A>, overrides?: DeepPartial<A>, ...traitNames: string[]): A {
    return factory.build(overrides, ...traitNames);
  }
}

export function defineFactory<T extends object>(options: FactoryOptions<T>): Factory<T> {
  return new Factory<T>(options);
}

export function resetSequences(): void {
  for (const key of Object.keys(sequences)) delete sequences[key];
}
