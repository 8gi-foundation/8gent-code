/**
 * A utility to automate income generation strategies
 */
export class MoneyMaker {
  private strategies: ((...args: any[]) => Promise<number>)[] = [];
  private totalEarnings: number = 0;

  /**
   * Add a strategy function that returns a promise of earnings
   * @param strategy - Function that generates income
   */
  addStrategy(strategy: (...args: any[]) => Promise<number>): void {
    this.strategies.push(strategy);
  }

  /**
   * Execute all strategies and aggregate results
   * @returns Total earnings from all strategies
   */
  async run(): Promise<number> {
    const results = await Promise.all(this.strategies.map(s => s()));
    this.totalEarnings += results.reduce((a, b) => a + b, 0);
    return this.totalEarnings;
  }

  /**
   * Get cumulative earnings
   */
  getEarnings(): number {
    return this.totalEarnings;
  }
}

/**
 * Example strategy: Simulated affiliate marketing
 * @returns Random earnings between $10-$50
 */
export function affiliateMarketing(): Promise<number> {
  return new Promise(resolve => {
    const amount = Math.floor(Math.random() * 41) + 10;
    setTimeout(() => resolve(amount), 1000);
  });
}

/**
 * Example strategy: Simulated freelancing
 * @returns Random earnings between $50-$200
 */
export function freelanceWork(): Promise<number> {
  return new Promise(resolve => {
    const amount = Math.floor(Math.random() * 151) + 50;
    setTimeout(() => resolve(amount), 1500);
  });
}