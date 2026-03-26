/**
 * Calculate churn risk score for a customer based on recency, frequency, and engagement.
 * @param customer - Customer data
 * @returns Risk score between 0 (low risk) and 100 (high risk)
 */
export function scoreCustomer(customer: { lastActiveDate: Date; sessionsLast30d: number; supportTickets: number; planAge: number }): number {
  const now = new Date();
  const daysSinceLastActive = Math.ceil((now.getTime() - customer.lastActiveDate.getTime()) / (1000 * 60 * 60 * 24));
  const recencyScore = daysSinceLastActive > 90 ? 100 : daysSinceLastActive > 30 ? ((daysSinceLastActive - 30) / 60) * 100 : 0;
  const frequencyScore = customer.sessionsLast30d === 0 ? 100 : customer.sessionsLast30d > 10 ? 0 : (10 - customer.sessionsLast30d) / 10 * 100;
  const supportScore = customer.supportTickets > 5 ? 100 : customer.supportTickets === 0 ? 0 : (customer.supportTickets / 5) * 100;
  const planAgeScore = customer.planAge < 30 ? 100 : customer.planAge > 180 ? 0 : (180 - customer.planAge) / 150 * 100;
  return Math.round((recencyScore + frequencyScore + supportScore + planAgeScore) / 4);
}

/**
 * Classify risk score into risk level
 * @param score - Risk score between 0-100
 * @returns Risk level: low | medium | high | critical
 */
export function classify(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score < 25) return 'low';
  if (score < 50) return 'medium';
  if (score < 75) return 'high';
  return 'critical';
}

/**
 * Batch score and sort customers by risk
 * @param customers - Array of customer objects
 * @returns Sorted list of customers with risk scores
 */
export function batchScore(customers: { lastActiveDate: Date; sessionsLast30d: number; supportTickets: number; planAge: number }[]): { customer: any; score: number }[] {
  return customers.map(c => ({ customer: c, score: scoreCustomer(c) })).sort((a, b) => b.score - a.score);
}

/**
 * Get top N at-risk customers
 * @param customers - Array of customer objects
 * @param n - Number of top risks to return
 * @returns Top N customers with risk scores
 */
export function topChurnRisks(customers: { lastActiveDate: Date; sessionsLast30d: number; supportTickets: number; planAge: number }[], n: number): { customer: any; score: number }[] {
  return batchScore(customers).slice(0, n);
}