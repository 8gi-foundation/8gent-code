/**
 * Estimates tokens based on character length (chars / 4).
 * @param text - Input text.
 * @returns Estimated token count.
 */
function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

/**
 * Allocates token budget proportionally across sections.
 * @param totalLimit - Total token limit.
 * @param sections - Object with system, history, context, outputReserve.
 * @returns Allocation of tokens to each section.
 */
function allocate(totalLimit: number, { system, history, context, outputReserve }: { system: number; history: number; context: number; outputReserve: number }): { system: number; history: number; context: number; outputReserve: number } {
  const totalAvailable = totalLimit - outputReserve;
  const sumSections = system + history + context;
  if (sumSections === 0) return { system: 0, history: 0, context: 0, outputReserve };
  const systemAlloc = (system / sumSections) * totalAvailable;
  const historyAlloc = (history / sumSections) * totalAvailable;
  const contextAlloc = (context / sumSections) * totalAvailable;
  return { system: systemAlloc, history: historyAlloc, context: contextAlloc, outputReserve };
}

/**
 * Calculates remaining available tokens after usage and reservation.
 * @param total - Total token limit.
 * @param used - Tokens already used.
 * @param reserved - Tokens reserved.
 * @returns Available tokens.
 */
function remaining(total: number, used: number, reserved: number): number {
  return Math.max(0, total - used - reserved);
}

/**
 * Trims sections to fit within a token budget, prioritizing longest sections.
 * @param sections - Object with text sections.
 * @param budget - Maximum allowed tokens.
 * @returns Trimmed sections.
 */
function fitWithinBudget(sections: { [key: string]: string }, budget: number): { [key: string]: string } {
  let currentSections = { ...sections };
  let totalTokens = Object.values(currentSections).reduce((sum, text) => sum + estimateTokens(text), 0);
  while (totalTokens > budget) {
    let maxKey = '', maxTokens = 0;
    for (const key in currentSections) {
      const tokens = estimateTokens(currentSections[key]);
      if (tokens > maxTokens) { maxTokens = tokens; maxKey = key; }
    }
    if (!maxKey) break;
    currentSections[maxKey] = currentSections[maxKey].slice(0, Math.floor(estimateTokens(currentSections[maxKey]) * 4) - 1);
    totalTokens = Object.values(currentSections).reduce((sum, text) => sum + estimateTokens(text), 0);
  }
  return currentSections;
}

/**
 * Renders token allocation as a table.
 * @param allocation - Token allocation object.
 * @returns Formatted table string.
 */
function renderBudget(allocation: { system: number; history: number; context: number; outputReserve: number }): string {
  const total = allocation.system + allocation.history + allocation.context + allocation.outputReserve;
  return `| Section       | Tokens | Percent |\n|---------------|--------|---------|\n| System        | ${allocation.system} | ${((allocation.system / total) * 100).toFixed(2)}% |\n| History       | ${allocation.history} | ${((allocation.history / total) * 100).toFixed(2)}% |\n| Context       | ${allocation.context} | ${((allocation.context / total) * 100).toFixed(2)}% |\n| Output Reserve| ${allocation.outputReserve} | ${((allocation.outputReserve / total) * 100).toFixed(2)}% |`;
}

export { estimateTokens, allocate, remaining, fitWithinBudget, renderBudget };