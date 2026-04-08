/**
 * fn-overload - Runtime function overloading by argument types
 *
 * Builds a dispatching function from ordered predicate/handler clauses.
 * First matching predicate wins. Falls back to `otherwise` handler if set,
 * or throws on no match.
 *
 * Usage:
 *   const greet = overload()
 *     .when((x): x is string => typeof x === "string", (name) => `Hello, ${name}!`)
 *     .when((x): x is number => typeof x === "number", (n) => `You are #${n}`)
 *     .otherwise((x) => `Unknown: ${String(x)}`)
 *     .build();
 *
 *   greet("Alice"); // "Hello, Alice!"
 *   greet(42);      // "You are #42"
 */

export type Predicate<TIn, TNarrowed extends TIn> = (
  arg: TIn
) => arg is TNarrowed;

export type GenericPredicate<TIn> = (arg: TIn) => boolean;

export type Handler<TArg, TReturn> = (arg: TArg) => TReturn;

interface Clause<TIn, TReturn> {
  predicate: GenericPredicate<TIn>;
  handler: Handler<TIn, TReturn>;
}

export class OverloadBuilder<TIn, TReturn> {
  private readonly clauses: Clause<TIn, TReturn>[] = [];
  private defaultHandler: Handler<TIn, TReturn> | null = null;

  /**
   * Register a predicate/handler pair.
   * Clauses are tested in insertion order - first match wins.
   */
  when<TNarrowed extends TIn>(
    predicate: Predicate<TIn, TNarrowed>,
    handler: Handler<TNarrowed, TReturn>
  ): OverloadBuilder<TIn, TReturn>;

  when(
    predicate: GenericPredicate<TIn>,
    handler: Handler<TIn, TReturn>
  ): OverloadBuilder<TIn, TReturn>;

  when(
    predicate: GenericPredicate<TIn>,
    handler: Handler<TIn, TReturn>
  ): OverloadBuilder<TIn, TReturn> {
    this.clauses.push({ predicate, handler });
    return this;
  }

  /**
   * Register a catch-all handler for when no clause matches.
   * If not set, an unmatched call throws `OverloadNoMatchError`.
   */
  otherwise(handler: Handler<TIn, TReturn>): OverloadBuilder<TIn, TReturn> {
    this.defaultHandler = handler;
    return this;
  }

  /**
   * Compile and return the dispatching function.
   */
  build(): (arg: TIn) => TReturn {
    const clauses = [...this.clauses];
    const defaultHandler = this.defaultHandler;

    return function dispatch(arg: TIn): TReturn {
      for (const clause of clauses) {
        if (clause.predicate(arg)) {
          return clause.handler(arg);
        }
      }

      if (defaultHandler !== null) {
        return defaultHandler(arg);
      }

      throw new OverloadNoMatchError(arg);
    };
  }
}

export class OverloadNoMatchError extends Error {
  constructor(public readonly value: unknown) {
    super(
      `No overload matched for value: ${JSON.stringify(value)} (type: ${typeof value})`
    );
    this.name = "OverloadNoMatchError";
  }
}

/**
 * Entry point. Returns a fresh OverloadBuilder.
 *
 * Provide generic params when TypeScript cannot infer them from context:
 *   overload<string | number, string>()
 */
export function overload<TIn = unknown, TReturn = unknown>(): OverloadBuilder<
  TIn,
  TReturn
> {
  return new OverloadBuilder<TIn, TReturn>();
}
