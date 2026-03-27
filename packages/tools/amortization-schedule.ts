/**
 * Amortization schedule entry
 * @typedef {Object} AmortizationPeriod
 * @property {number} period - Payment period (1-based)
 * @property {number} payment - Total monthly payment
 * @property {number} interest - Interest portion of payment
 * @property {number} principal - Principal portion of payment
 * @property {number} balance - Remaining loan balance
 */

/**
 * Calculate monthly payment using PMT formula
 * @param {number} principal - Loan principal
 * @param {number} rate - Annual interest rate (as decimal)
 * @param {number} months - Loan term in months
 * @returns {number} Monthly payment amount
 */
function monthlyPayment(principal: number, rate: number, months: number): number {
  const r = rate / 12
  return principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
}

/**
 * Generate full amortization schedule
 * @param {number} principal - Loan principal
 * @param {number} rate - Annual interest rate (as decimal)
 * @param {number} termMonths - Loan term in months
 * @returns {AmortizationPeriod[]} Amortization schedule
 */
function generate(principal: number, rate: number, termMonths: number): Array<{ period: number; payment: number; interest: number; principal: number; balance: number }> {
  const schedule: Array<{ period: number; payment: number; interest: number; principal: number; balance: number }> = []
  const payment = monthlyPayment(principal, rate, termMonths)
  let balance = principal
  for (let i = 1; i <= termMonths; i++) {
    const interest = balance * (rate / 12)
    const principalPortion = payment - interest
    balance -= principalPortion
    schedule.push({ period: i, payment, interest, principal: principalPortion, balance })
  }
  return schedule
}

/**
 * Generate summary statistics from schedule
 * @param {Array<{ period: number; payment: number; interest: number; principal: number; balance: number }>} schedule - Amortization schedule
 * @returns {Object} Summary with total interest, total paid, and payoff date
 */
function summary(schedule: Array<{ period: number; payment: number; interest: number; principal: number; balance: number }>): { totalInterest: number; totalPaid: number; payoffDate: string } {
  const totalInterest = schedule.reduce((sum, p) => sum + p.interest, 0)
  const totalPaid = schedule.reduce((sum, p) => sum + p.payment, 0)
  const startDate = new Date(2023, 0, 1)
  const payoffDate = new Date(startDate)
  payoffDate.setMonth(startDate.getMonth() + schedule.length - 1)
  return { totalInterest, totalPaid, payoffDate: payoffDate.toISOString().split('T')[0] }
}

/**
 * Calculate remaining balance at specific month
 * @param {Array<{ period: number; payment: number; interest: number; principal: number; balance: number }>} schedule - Amortization schedule
 * @param {number} month - Target month (1-based)
 * @returns {number} Remaining balance
 */
function payoffAt(schedule: Array<{ period: number; payment: number; interest: number; principal: number; balance: number }>, month: number): number {
  const entry = schedule.find(p => p.period === month)
  return entry ? entry.balance : 0
}

/**
 * Render formatted amortization table (first/last 3 periods)
 * @param {Array<{ period: number; payment: number; interest: number; principal: number; balance: number }>} schedule - Amortization schedule
 * @returns {string} Formatted table
 */
function renderTable(schedule: Array<{ period: number; payment: number; interest: number; principal: number; balance: number }>): string {
  const rows = [...schedule]
  const max = 3
  if (rows.length > 2 * max) {
    rows.splice(max, rows.length - 2 * max)
    rows[rows.length - 1] = { ...rows[rows.length - 1], period: '...' }
  }
  return rows.map(p => 
    `${p.period.toString().padStart(5)} | $${p.payment.toFixed(2)} | $${p.interest.toFixed(2)} | $${p.principal.toFixed(2)} | $${p.balance.toFixed(2)}`
  ).join('\n')
}

export { monthlyPayment, generate, summary, payoffAt, renderTable }