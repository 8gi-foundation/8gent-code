import { useState, useCallback, useRef } from "react";

export interface AsyncTaskResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  run: () => void;
  reset: () => void;
}

export function useAsyncTask<T>(taskFn: () => Promise<T>): AsyncTaskResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const runIdRef = useRef<number>(0);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  const run = useCallback(() => {
    runIdRef.current += 1;
    const currentRunId = runIdRef.current;

    setData(null);
    setError(null);
    setLoading(true);

    taskFn()
      .then((result) => {
        if (runIdRef.current === currentRunId) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (runIdRef.current === currentRunId) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });
  }, [taskFn]);

  return { data, error, loading, run, reset };
}
