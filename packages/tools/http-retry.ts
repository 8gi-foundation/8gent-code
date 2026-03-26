/**
 * Fetches a URL with exponential backoff retry on 5xx and network errors.
 * @param url - The URL to fetch.
 * @param init - Fetch initialization options.
 * @param opts - Retry options.
 * @returns The last response or throws after exhausting retries.
 */
export function fetchWithRetry(url: string, init: RequestInit, opts: { maxRetries?: number; baseDelay?: number } = {}): Promise<Response> {
  const { maxRetries = 3, baseDelay = 300 } = opts;
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      lastResponse = response;
      if (response.ok) return response;
      if (response.status >= 500 && response.status < 600) {
        const retryAfter = response.headers.get('Retry-After');
        let delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return lastResponse;
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  if (lastResponse) return lastResponse;
  throw new Error('All retries failed');
}