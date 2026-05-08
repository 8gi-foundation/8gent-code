/**
 * proxy-handler.ts
 * JavaScript Proxy-based object interceptors for logging, validation, and access control.
 */

export type AccessLog = {
  op: "get" | "set" | "delete" | "has";
  key: string | symbol;
  value?: unknown;
  timestamp: number;
};

export type ProxyHandlerOptions = {
  onAccess?: (log: AccessLog) => void;
  validators?: Record<string | symbol, (value: unknown) => boolean | string>;
  readOnly?: boolean;
  deep?: boolean;
};

const proxyCache = new WeakMap<object, object>();

function wrapDeep<T extends object>(target: T, options: ProxyHandlerOptions): T {
  if (proxyCache.has(target)) return proxyCache.get(target) as T;
  const proxy = createProxy(target, options);
  proxyCache.set(target, proxy);
  return proxy;
}

/**
 * Create a Proxy around `target` with the given handler options.
 */
export function createProxy<T extends object>(target: T, options: ProxyHandlerOptions = {}): T {
  const { onAccess, validators = {}, readOnly = false, deep = false } = options;

  const handler: ProxyHandler<T> = {
    get(obj, key, receiver) {
      onAccess?.({ op: "get", key, timestamp: Date.now() });
      const value = Reflect.get(obj, key, receiver);
      if (deep && value !== null && typeof value === "object") {
        return wrapDeep(value as object, options);
      }
      return value;
    },

    set(obj, key, value, receiver) {
      if (readOnly) {
        throw new TypeError(`Cannot set property "${String(key)}" - object is read-only`);
      }
      if (validators[key]) {
        const result = validators[key](value);
        if (result !== true) {
          const msg = typeof result === "string" ? result : `Validation failed for "${String(key)}"`;
          throw new TypeError(msg);
        }
      }
      onAccess?.({ op: "set", key, value, timestamp: Date.now() });
      return Reflect.set(obj, key, value, receiver);
    },

    deleteProperty(obj, key) {
      if (readOnly) {
        throw new TypeError(`Cannot delete property "${String(key)}" - object is read-only`);
      }
      onAccess?.({ op: "delete", key, timestamp: Date.now() });
      return Reflect.deleteProperty(obj, key);
    },

    has(obj, key) {
      onAccess?.({ op: "has", key, timestamp: Date.now() });
      return Reflect.has(obj, key);
    },
  };

  return new Proxy(target, handler);
}

/**
 * Wrap an object so all writes and deletes throw immediately.
 * Nested objects are also frozen when accessed.
 */
export function readOnly<T extends object>(obj: T): T {
  return createProxy(obj, { readOnly: true, deep: true });
}

/**
 * Wrap an object and collect an access log for every get/set/delete/has.
 * Returns both the proxied object and the live log array.
 */
export function logged<T extends object>(obj: T): { proxy: T; log: AccessLog[] } {
  const log: AccessLog[] = [];
  const proxy = createProxy(obj, {
    onAccess: (entry) => log.push(entry),
  });
  return { proxy, log };
}

/**
 * Wrap an object with per-key validators. Validators return true on success
 * or a string error message on failure.
 */
export function validated<T extends object>(
  obj: T,
  validators: Record<string | symbol, (value: unknown) => boolean | string>
): T {
  return createProxy(obj, { validators });
}

/**
 * Deep proxy - every nested object access also gets wrapped.
 */
export function deepProxy<T extends object>(obj: T, options: Omit<ProxyHandlerOptions, "deep"> = {}): T {
  return createProxy(obj, { ...options, deep: true });
}
