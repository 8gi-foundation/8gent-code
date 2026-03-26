import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * React hook for managing async operations with loading/error state.
 * @param fn Async function to execute.
 * @param deps Dependencies to trigger re-run.
 * @returns Object with data, loading, error, and refresh.
 */
function useAsync<T>(fn: () => Promise<T>, deps: any[]): { data: T | undefined; loading: boolean; error: Error | null; refresh: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const runAsync = useCallback(async () => {
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setLoading(true);
    setError(null);

    try {
      const result = await fn();
      setData(result);
    } catch (e) {
      if (abortController.signal.aborted) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [fn]);

  useEffect(() => {
    runAsync();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [deps, fn]);

  const refresh = useCallback(() => runAsync(), [runAsync]);

  return { data, loading, error, refresh };
}

export { useAsync };