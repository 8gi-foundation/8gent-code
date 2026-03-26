/**
 * Reformulates user question for retrieval with conversation history context
 * @param userQuestion - Original user question
 * @param conversationHistory - Array of previous messages
 * @returns Query string optimized for retrieval
 */
export function buildQuery(userQuestion: string, conversationHistory: string[]): string {
  const historyContext = conversationHistory.join(' ').substring(0, 512)
  return `${historyContext} ${userQuestion}`
}

/**
 * Sorts chunks by relevance score and returns top-k results
 * @param chunks - Array of text chunks to rank
 * @param query - Current query for relevance scoring
 * @param scoreFn - Function that returns relevance score (lower is better)
 * @returns Top ranked chunks
 */
export function rankChunks(chunks: string[], query: string, scoreFn: (chunk: string, query: string) => number): string[] {
  return [...chunks].sort((a, b) => scoreFn(a, query) - scoreFn(b, query))
}

/**
 * Trims chunks to fit within token budget while preserving order
 * @param chunks - Array of ranked chunks
 * @param tokenBudget - Maximum token count allowed
 * @returns Truncated array fitting within budget
 */
export function assembleContext(chunks: string[], tokenBudget: number): string[] {
  let totalTokens = 0
  const result: string[] = []
  
  for (const chunk of chunks) {
    const chunkTokens = Math.floor(chunk.length / 4) // Rough token estimation
    if (totalTokens + chunkTokens > tokenBudget) break
    result.push(chunk)
    totalTokens += chunkTokens
  }
  
  return result
}

/**
 * Assembles final prompt with query, context, and system instructions
 * @param query - Original user query
 * @param context - Assembled context chunks
 * @param systemPrompt - System instruction template
 * @returns Final prompt ready for LLM processing
 */
export function buildPrompt(query: string, context: string[], systemPrompt: string): string {
  return `${systemPrompt}\n\n${context.join('\n\n')}\n\nQuery: ${query}`
}