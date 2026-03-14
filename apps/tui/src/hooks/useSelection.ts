import { useState, useCallback, useEffect } from "react";

export interface SelectionOptions {
  loop?: boolean;
}

export interface SelectionResult<T> {
  selectedIndex: number;
  selectedItem: T | undefined;
  next: () => void;
  prev: () => void;
  select: (index: number) => void;
  reset: () => void;
}

export function useSelection<T>(
  items: T[],
  options?: SelectionOptions,
): SelectionResult<T> {
  const loop = options?.loop ?? true;
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  // Clamp index when items array changes
  useEffect(() => {
    if (items.length === 0) {
      setSelectedIndex(0);
    } else {
      setSelectedIndex((prev) => Math.min(prev, items.length - 1));
    }
  }, [items.length]);

  const next = useCallback(() => {
    if (items.length === 0) return;
    setSelectedIndex((prev) => {
      if (prev >= items.length - 1) {
        return loop ? 0 : prev;
      }
      return prev + 1;
    });
  }, [items.length, loop]);

  const prev = useCallback(() => {
    if (items.length === 0) return;
    setSelectedIndex((prev) => {
      if (prev <= 0) {
        return loop ? items.length - 1 : prev;
      }
      return prev - 1;
    });
  }, [items.length, loop]);

  const select = useCallback(
    (index: number) => {
      if (items.length === 0) return;
      const clamped = Math.max(0, Math.min(index, items.length - 1));
      setSelectedIndex(clamped);
    },
    [items.length],
  );

  const reset = useCallback(() => {
    setSelectedIndex(0);
  }, []);

  return {
    selectedIndex,
    selectedItem: items[selectedIndex],
    next,
    prev,
    select,
    reset,
  };
}
