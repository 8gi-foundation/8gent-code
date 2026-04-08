/**
 * Creates a proxied object with a subconscious layer.
 * @param target The original object to wrap.
 * @returns A proxied object with a `getSubconscious` method to access the subconscious state.
 */
export function createSubconscious<T>(target: T): T {
  const state = new Map<string, any>();

  return new Proxy(target, {
    get: (obj, prop) => {
      if (prop === 'getSubconscious') {
        return () => state;
      }
      if (state.has(prop as string)) {
        return state.get(prop as string);
      }
      return Reflect.get(obj, prop);
    },
    set: (obj, prop, value) => {
      if (prop === 'getSubconscious') {
        // Prevent overriding the getSubconscious method
        return false;
      }
      state.set(prop as string, value);
      return Reflect.set(obj, prop, value);
    },
  });
}