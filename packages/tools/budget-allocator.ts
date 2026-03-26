/**
 * Allocates a total budget across channels based on their weights.
 * @param totalBudget - Total budget to allocate.
 * @param channels - List of channel IDs.
 * @param weights - Weight object mapping channel IDs to their weights.
 * @returns Allocation object with channel IDs as keys and allocated amounts as values.
 */
export function allocate(totalBudget: number, channels: string[], weights: { [key: string]: number }): { [key: string]: number } {
  const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
  const allocation: { [key: string]: number } = {};
  for (const channel of channels) {
    allocation[channel] = (weights[channel] / totalWeight) * totalBudget;
  }
  return allocation;
}

/**
 * Applies a maximum cap to a specific channel's allocation.
 * @param allocation - Current allocation object.
 * @param channelId - Channel ID to apply the cap to.
 * @param maxAmount - Maximum allowed amount for the channel.
 * @returns Updated allocation object with the cap applied.
 */
export function applyCap(allocation: { [key: string]: number }, channelId: string, maxAmount: number): { [key: string]: number } {
  const newAllocation = { ...allocation };
  if (newAllocation[channelId] > maxAmount) {
    newAllocation[channelId] = maxAmount;
  }
  return newAllocation;
}

/**
 * Runs multiple allocation scenarios side by side.
 * @param budget - Budget to allocate for each scenario.
 * @param scenarios - Object mapping scenario names to configuration objects.
 * @returns Object mapping scenario names to their allocation results.
 */
export function scenario(budget: number, scenarios: { [key: string]: { channels: string[], weights: { [key: string]: number }, caps: { [key: string]: number } } }): { [key: string]: { [key: string]: number } } {
  const results: { [key: string]: { [key: string]: number } } = {};
  for (const [scenarioName, config] of Object.entries(scenarios)) {
    let alloc = allocate(budget, config.channels, config.weights);
    for (const [channelId, cap] of Object.entries(config.caps)) {
      alloc = applyCap(alloc, channelId, cap);
    }
    results[scenarioName] = alloc;
  }
  return results;
}

/**
 * Renders an ASCII bar chart of budget distribution.
 * @param allocation - Allocation object with channel IDs as keys and amounts as values.
 * @returns String representing the ASCII bar chart.
 */
export function renderBreakdown(allocation: { [key: string]: number }): string {
  const entries = Object.entries(allocation);
  const maxAmount = Math.max(...entries.map(([_, amount]) => amount));
  const barLength = 50;
  return entries.map(([channel, amount]) => {
    const bar = '█'.repeat(Math.round((amount / maxAmount) * barLength));
    return `${channel}: ${bar} (${amount.toFixed(2)})`;
  }).join('\n');
}