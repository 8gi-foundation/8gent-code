/**
 * React hook for declarative setInterval with cleanup.
 * @param callback The function to execute on each interval.
 * @param delay The delay in milliseconds, or null to pause.
 */
export function useInterval(callback: () => void, delay: number | null): void {
  const callbackRef = useRef<() => void>(callback);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const id = setInterval(() => {
      callbackRef.current();
    }, delay);

    intervalRef.current = id;

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [delay]);
}