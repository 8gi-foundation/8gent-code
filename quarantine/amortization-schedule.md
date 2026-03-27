# amortization-schedule

Loan amortization schedule generator with monthly payments, interest, principal splits, and totals.

## Requirements
- generate({ principal, rate, termMonths }): full amortization schedule
- monthlyPayment(principal, rate, months): PMT formula
- summary(schedule): total interest paid, total paid, payoff date
- payoffAt(schedule, month): remaining balance at any month
- renderTable(schedule): formatted amortization table (first/last 3 periods)

## Status

Quarantine - pending review.

## Location

`packages/tools/amortization-schedule.ts`
