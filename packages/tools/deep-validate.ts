/**
 * Validator class for deeply validating object trees with path-based error reporting.
 * @template T - The type of the object being validated.
 */
class Validator<T> {
  /**
   * Creates a new Validator instance.
   * @param rules - A function that validates a value at a given path. Returns an error message or null.
   */
  constructor(private rules: (value: any, path: string) => string | null) {}

  /**
   * Validates the object tree and returns an array of errors.
   * @param obj - The object to validate.
   * @returns An array of error objects with path and message.
   */
  validate(obj: T): { path: string; message: string }[] {
    const errors: { path: string; message: string }[] = [];

    const traverse = (current: any, currentPath: string): void => {
      const error = this.rules(current, currentPath);
      if (error) {
        errors.push({ path: currentPath, message: error });
      }

      if (typeof current === 'object' && current !== null) {
        for (const key in current) {
          if (current.hasOwnProperty(key)) {
            traverse(current[key], `${currentPath}.${key}`);
          }
        }
      }
    };

    traverse(obj, '');
    return errors;
  }
}

export { Validator };