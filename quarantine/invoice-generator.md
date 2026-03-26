# invoice-generator

Generate a complete invoice as structured data with line items, subtotal, tax, discounts, and total.

## Requirements
- createInvoice({ client, items, taxRate, discount }): returns Invoice object
- addLineItem(invoice, { description, qty, unitPrice }): returns updated invoice
- calculateTotals(invoice): computes subtotal, taxAmount, discountAmount, total
- renderText(invoice): renders plain-text invoice ready for PDF or email
- toCSV(invoice): exports line items as CSV

## Status

Quarantine - pending review.

## Location

`packages/tools/invoice-generator.ts`
