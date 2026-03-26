/**
 * An observable sequence.
 */
export class Observable<T> {
  constructor(private subscribeFn: (observer: Observer<T>) => Subscription) {}

  /**
   * Subscribes to the observable.
   * @param observer The observer to subscribe.
   * @returns A subscription that can be unsubscribed.
   */
  subscribe(observer: Observer<T>): Subscription {
    return this.subscribeFn(observer);
  }
}

/**
 * A subject that can be both observed and used to emit values.
 */
export class Subject<T> extends Observable<T> {
  private subscribers: Observer<T>[] = [];

  /**
   * Emits a value to all subscribers.
   * @param value The value to emit.
   */
  next(value: T): void {
    this.subscribers.forEach(sub => sub.next(value));
  }

  /**
   * Emits an error to all subscribers.
   * @param err The error to emit.
   */
  error(err: any): void {
    this.subscribers.forEach(sub => sub.error(err));
  }

  /**
   * Completes the sequence to all subscribers.
   */
  complete(): void {
    this.subscribers.forEach(sub => sub.complete());
  }

  /**
   * Subscribes to the subject.
   * @param observer The observer to subscribe.
   * @returns A subscription that can be unsubscribed.
   */
  subscribe(observer: Observer<T>): Subscription {
    this.subscribers.push(observer);
    return {
      unsubscribe: () => {
        this.subscribers = this.subscribers.filter(sub => sub !== observer);
      }
    };
  }
}

/**
 * Applies a mapping function to each value.
 * @param fn The mapping function.
 * @returns A function that transforms an observable.
 */
export function map<T, R>(fn: (value: T) => R): (source: Observable<T>) => Observable<R> {
  return (source) => {
    return new Observable<R>(observer => {
      return source.subscribe({
        next: (value) => observer.next(fn(value)),
        error: (err) => observer.error(err),
        complete: () => observer.complete()
      });
    });
  };
}

/**
 * Filters values based on a predicate.
 * @param fn The predicate function.
 * @returns A function that transforms an observable.
 */
export function filter<T>(fn: (value: T) => boolean): (source: Observable<T>) => Observable<T> {
  return (source) => {
    return new Observable<T>(observer => {
      return source.subscribe({
        next: (value) => {
          if (fn(value)) observer.next(value);
        },
        error: (err) => observer.error(err),
        complete: () => observer.complete()
      });
    });
  };
}

/**
 * Takes a specified number of values.
 * @param n The number of values to take.
 * @returns A function that transforms an observable.
 */
export function take<T>(n: number): (source: Observable<T>) => Observable<T> {
  return (source) => {
    return new Observable<T>(observer => {
      let count = 0;
      return source.subscribe({
        next: (value) => {
          if (count < n) {
            observer.next(value);
            count++;
          }
        },
        error: (err) => observer.error(err),
        complete: () => observer.complete()
      });
    });
  };
}

/**
 * Composes multiple operators.
 * @param operators The operators to compose.
 * @returns A function that applies the composed operators.
 */
export function pipe<T>(...operators: Array<(source: Observable<T>) => Observable<any>>): (source: Observable<T>) => Observable<any> {
  return (source) => {
    return operators.reduce((acc, operator) => operator(acc), source);
  };
}

/**
 * A subscription that can be unsubscribed.
 */
export interface Subscription {
  unsubscribe(): void;
}

/**
 * An observer with next, error, and complete methods.
 */
export interface Observer<T> {
  next: (value: T) => void;
  error: (err: any) => void;
  complete: () => void;
}