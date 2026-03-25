/**
 * tagged-union.ts
 *
 * Discriminated union helpers for TypeScript.
 * Provides variant constructors, exhaustive pattern matching, and type guards
 * without any external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A tagged union variant has a `type` discriminant plus an optional payload. */
export type Variant<T extends string, P = Record<string, never>> = P extends Record<string, never>
  ? { readonly type: T }
  : { readonly type: T } & P;

/**
 * Infer the union type from a union definition map.
 * Keys are variant names; values are payload types (use `null` for no payload).
 */
export type UnionOf<D extends Record<string, object | null>> = {
  [K in keyof D]: D[K] extends null
    ? { readonly type: K }
    : { readonly type: K } & D[K];
}[keyof D];

/** Handlers map - one function per variant, keyed by discriminant. */
export type Handlers<U extends { type: string }, R> = {
  [K in U["type"]]: (variant: Extract<U, { type: K }>) => R;
};

// ---------------------------------------------------------------------------
// createUnion
// ---------------------------------------------------------------------------

/**
 * Build a set of variant constructors from a union definition.
 *
 * @example
 * ```ts
 * type Shape =
 *   | { type: "circle"; radius: number }
 *   | { type: "rect"; width: number; height: number }
 *   | { type: "point" };
 *
 * const Shape = createUnion<Shape>();
 * const c = Shape.circle({ radius: 5 });   // { type: "circle", radius: 5 }
 * const r = Shape.rect({ width: 4, height: 3 });
 * const p = Shape.point();                  // { type: "point" }
 * ```
 */
export function createUnion<U extends { type: string }>(): {
  [K in U["type"]]: (
    payload?: Omit<Extract<U, { type: K }>, "type">
  ) => Extract<U, { type: K }>;
} {
  return new Proxy({} as ReturnType<typeof createUnion<U>>, {
    get(_target, key: string) {
      return (payload?: object) =>
        Object.freeze({ type: key, ...(payload ?? {}) });
    },
  });
}

// ---------------------------------------------------------------------------
// match
// ---------------------------------------------------------------------------

/**
 * Exhaustive pattern match over a discriminated union.
 * TypeScript enforces that every variant is handled at compile time.
 *
 * @example
 * ```ts
 * const area = match(shape, {
 *   circle: ({ radius }) => Math.PI * radius ** 2,
 *   rect:   ({ width, height }) => width * height,
 *   point:  () => 0,
 * });
 * ```
 */
export function match<U extends { type: string }, R>(
  value: U,
  handlers: Handlers<U, R>
): R {
  const handler = (handlers as Record<string, (v: U) => R>)[value.type];
  if (!handler) {
    throw new Error(
      `[tagged-union] match: no handler for variant "${value.type}"`
    );
  }
  return handler(value);
}

// ---------------------------------------------------------------------------
// matchPartial
// ---------------------------------------------------------------------------

/**
 * Partial pattern match with a required fallback for unhandled variants.
 *
 * @example
 * ```ts
 * const label = matchPartial(shape, {
 *   circle: ({ radius }) => `Circle r=${radius}`,
 *   _: (v) => v.type,
 * });
 * ```
 */
export function matchPartial<U extends { type: string }, R>(
  value: U,
  handlers: Partial<Handlers<U, R>> & { _: (v: U) => R }
): R {
  const handler = (handlers as Record<string, (v: U) => R>)[value.type];
  return handler ? handler(value) : handlers._(value);
}

// ---------------------------------------------------------------------------
// isVariant
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows a union to a specific variant.
 *
 * @example
 * ```ts
 * if (isVariant(shape, "circle")) {
 *   console.log(shape.radius); // narrowed to circle variant
 * }
 * ```
 */
export function isVariant<U extends { type: string }, K extends U["type"]>(
  value: U,
  variant: K
): value is Extract<U, { type: K }> {
  return value.type === variant;
}
