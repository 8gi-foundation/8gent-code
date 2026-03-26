/**
 * Tracker object structure.
 */
export interface Tracker {
  affiliates: Map<string, { name: string; commissionRate: number; conversions: Array<{ orderId: string; amount: number }> }>;
}

/**
 * Creates an affiliate in the tracker.
 * @param tracker - The tracker object.
 * @param options - Affiliate options.
 * @param options.id - Affiliate ID.
 * @param options.name - Affiliate name.
 * @param options.commissionRate - Commission rate (as a decimal).
 */
export function createAffiliate(tracker: Tracker, options: { id: string; name: string; commissionRate: number }): void {
  tracker.affiliates.set(options.id, { name: options.name, commissionRate: options.commissionRate, conversions: [] });
}

/**
 * Logs a conversion for an affiliate.
 * @param tracker - The tracker object.
 * @param options - Conversion options.
 * @param options.affiliateId - ID of the affiliate.
 * @param options.orderId - Order ID.
 * @param options.amount - Conversion amount.
 */
export function logConversion(tracker: Tracker, options: { affiliateId: string; orderId: string; amount: number }): void {
  const affiliate = tracker.affiliates.get(options.affiliateId);
  if (affiliate) {
    affiliate.conversions.push({ orderId: options.orderId, amount: options.amount });
  }
}

/**
 * Calculates commissions for all affiliates.
 * @param tracker - The tracker object.
 * @returns Array of commission details per affiliate.
 */
export function calculateCommissions(tracker: Tracker): Array<{ affiliateId: string; conversions: number; revenue: number; commission: number }> {
  const result: Array<{ affiliateId: string; conversions: number; revenue: number; commission: number }> = [];
  for (const [id, affiliate] of tracker.affiliates.entries()) {
    const totalRevenue = affiliate.conversions.reduce((sum, conv) => sum + conv.amount, 0);
    result.push({
      affiliateId: id,
      conversions: affiliate.conversions.length,
      revenue: totalRevenue,
      commission: totalRevenue * affiliate.commissionRate,
    });
  }
  return result;
}

/**
 * Returns top affiliates by commission earned.
 * @param tracker - The tracker object.
 * @param n - Number of top affiliates to return.
 * @returns Sorted list of top affiliates.
 */
export function topAffiliates(tracker: Tracker, n: number): Array<{ affiliateId: string; conversions: number; revenue: number; commission: number }> {
  return calculateCommissions(tracker)
    .sort((a, b) => b.commission - a.commission)
    .slice(0, n);
}

/**
 * Renders a markdown payout report.
 * @param tracker - The tracker object.
 * @returns Markdown table of payout summary.
 */
export function renderPayoutReport(tracker: Tracker): string {
  const data = calculateCommissions(tracker);
  if (data.length === 0) return '';
  const headers = ['Affiliate ID', 'Conversions', 'Revenue', 'Commission'];
  const rows = data.map(
    ({ affiliateId, conversions, revenue, commission }) =>
      `| ${affiliateId} | ${conversions} | $${revenue.toFixed(2)} | $${commission.toFixed(2)} |`
  );
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows,
  ].join('\n');
}