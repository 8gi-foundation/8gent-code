import React, { useState, useEffect } from 'react';

/**
 * React hook to check if a media query matches.
 * @param query - The media query string.
 * @returns True if the media query matches, false otherwise.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') {
      setMatches(false);
      return;
    }
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = () => setMatches(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return matches;
}

/**
 * React hook to determine the current breakpoint.
 * @param breakpoints - Object mapping breakpoint keys to media queries.
 * @returns The current breakpoint key or undefined.
 */
export function useBreakpoint(breakpoints: Record<string, string>): string | undefined {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === 'undefined') {
      setCurrent(undefined);
      return;
    }
    const check = () => {
      for (const [key, query] of Object.entries(breakpoints)) {
        if (window.matchMedia(query).matches) {
          setCurrent(key);
          return;
        }
      }
      setCurrent(undefined);
    };
    check();
    const listener = () => check();
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, [breakpoints]);
  return current;
}