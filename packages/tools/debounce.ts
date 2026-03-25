/**
 * Debounce a function with cancellation support.
 * @param fn - Function to debounce
 * @param delayMs - Delay in milliseconds
 * @param options - Debounce options (trailing, leading)
 * @returns Debounced function with .cancel() method
 */
function debounce<TArgs, TReturn>(
  fn: (...args: TArgs[]) => TReturn,
  delayMs: number,
  options: { trailing?: boolean; leading?: boolean } = {}
): (...args: TArgs[]) => Promise<TReturn> {
  let timeoutId: number | null = null
  let lastArgs: TArgs[] | null = null

  const wrapped = (...args: TArgs[]): Promise<TReturn> => {
    return new Promise<TReturn>((resolve, reject) => {
      let isCancelled = false
      const cancel = () => {
        isCancelled = true
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        reject('cancelled')
      }

      if (timeoutId !== null) clearTimeout(timeoutId)
      lastArgs = args

      const execute = () => {
        if (isCancelled) return
        try {
          resolve(fn(...lastArgs))
        } catch (e) {
          reject(e)
        }
        lastArgs = null
      }

      if (options.leading) execute()

      if (options.trailing) {
        timeoutId = setTimeout(() => {
          if (!isCancelled && lastArgs !== null) execute()
        }, delayMs)
      }
    })
  }

  wrapped.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return wrapped
}

/**
 * Throttle a function with cancellation support.
 * @param fn - Function to throttle
 * @param intervalMs - Interval in milliseconds
 * @returns Throttled function with .cancel() method
 */
function throttle<TArgs, TReturn>(
  fn: (...args: TArgs[]) => TReturn,
  intervalMs: number
): (...args: TArgs[]) => Promise<TReturn> {
  let lastExecuted: number | null = null
  let timeoutId: number | null = null

  const wrapped = (...args: TArgs[]): Promise<TReturn> => {
    return new Promise<TReturn>((resolve, reject) => {
      let isCancelled = false
      const cancel = () => {
        isCancelled = true
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        reject('cancelled')
      }

      const now = performance.now()
      if (lastExecuted === null || now - lastExecuted >= intervalMs) {
        try {
          resolve(fn(...args))
          lastExecuted = now
        } catch (e) {
          reject(e)
        }
      } else {
        timeoutId = setTimeout(() => {
          if (!isCancelled) wrapped(...args)
        }, intervalMs - (now - lastExecuted!))
      }
    })
  }

  wrapped.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return wrapped
}

export { debounce, throttle }