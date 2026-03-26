import { useRef } from 'react';

/**
 * Returns the previous render's value of the given variable.
 * @param value The current value.
 * @returns The previous value, or undefined on first render.
 */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>();
  const prev = ref.current;
  ref.current = value;
  return prev;
}