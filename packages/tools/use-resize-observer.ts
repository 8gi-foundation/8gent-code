import { useState, useEffect, useRef } from 'react';

/**
 * React hook that wraps ResizeObserver to track element size changes.
 * @param ref - React.RefObject<HTMLElement> to observe
 * @returns Object with width and height of the element
 */
function useResizeObserver(ref: React.RefObject<HTMLElement>): { width: number; height: number } {
  // Check for SSR and ResizeObserver support
  if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
    return { width: 0, height: 0 };
  }

  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);

  // Debounce function
  const debounce = (fn: () => void, delay: number) => {
    let timeoutId: number;
    return (...args: any[]) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
  };

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(debounce(() => {
      setWidth(element.offsetWidth);
      setHeight(element.offsetHeight);
    }, 200));

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return { width, height };
}

export { useResizeObserver };