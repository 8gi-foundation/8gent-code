import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Debounces a value and returns the debounced value.
 * @param value The value to debounce.
 * @param delay The delay in milliseconds.
 * @returns The debounced value.
 */
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

/**
 * Returns a stable debounced function.
 * @param fn The function to debounce.
 * @param delay The delay in milliseconds.
 * @returns The debounced function.
 */
function useDebouncedCallback<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  const latestFn = useRef(fn);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    latestFn.current = fn;
  }, [fn]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const debouncedFn = useCallback((...args: Parameters<T>) => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      latestFn.current(...args);
    }, delay);
  }, [delay]);

  return debouncedFn as T;
}

export { useDebounce, useDebouncedCallback };