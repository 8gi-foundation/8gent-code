/**
 * Limits concurrent async tasks with a promise pool.
 * @param tasks Array of async functions to execute.
 * @param concurrency Maximum number of concurrent tasks.
 * @param allSettled If true, collect all results including rejections.
 * @returns Promise that resolves with results in input order.
 */
export function pool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  allSettled?: boolean
): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  const queue = tasks.map((task, index) => ({ task, index }));
  let counter = concurrency;
  let errorOccurred = false;
  return new Promise<T[]>((resolve, reject) => {
    async function processNext() {
      if (counter > 0 && queue.length > 0) {
        const { task, index } = queue.shift()!;
        counter--;
        try {
          const result = await task();
          results[index] = result;
        } catch (e) {
          if (!allSettled) {
            errorOccurred = true;
            reject(e);
            return;
          } else {
            results[index] = e as T;
          }
        } finally {
          counter++;
        }
        await processNext();
      } else if (queue.length === 0 && !errorOccurred) {
        resolve(results as T[]);
      }
    }
    processNext();
  });
}