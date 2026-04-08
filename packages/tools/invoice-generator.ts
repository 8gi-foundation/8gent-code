export interface LineItem {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface Totals {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  total: number;
}

export interface Invoice {
  client: string;
  items: LineItem[];
  taxRate: number;
  discount: number;
  totals: Totals;
}

export interface CreateInvoiceParams {
  client: string;
  items: LineItem[];
  taxRate: number;
  discount: number;
}

export interface LineItemParams {
  description: string;
  qty: number;
  unitPrice: number;
}

/**
 * Creates a new invoice with the given parameters.
 * @param params - The parameters for creating the invoice.
 * @returns The created invoice.
 */
export function createInvoice(params: CreateInvoiceParams): Invoice {
  const { client, items, taxRate, discount } = params;
  const invoice: Omit<Invoice, 'totals'> = { client, items, taxRate, discount };
  return {
    ...invoice,
    totals: calculateTotals(invoice)
  };
}

/**
 * Adds a line item to the invoice.
 * @param invoice - The existing invoice.
 * @param params - The line item parameters.
 * @returns The updated invoice with the new line item.
 */
export function addLineItem(invoice: Invoice, params: LineItemParams): Invoice {
  const { description, qty, unitPrice } = params;
  const newItems = [...invoice.items, { description, qty, unitPrice }];
  return {
    ...invoice,
    items: newItems,
    totals: calculateTotals({ ...invoice, items: newItems })
  };
}

/**
 * Calculates the totals for the invoice.
 * @param invoice - The invoice to calculate totals for.
 * @returns The calculated totals.
 */
export function calculateTotals(invoice: Invoice): Totals {
  const subtotal = invoice.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  const discountAmount = subtotal * (invoice.discount / 100);
  const taxAmount = (subtotal - discountAmount) * (invoice.taxRate / 100);
  const total = subtotal - discountAmount + taxAmount;
  return { subtotal, taxAmount, discountAmount, total };
}

/**
 * Renders the invoice as plain text.
 * @param invoice - The invoice to render.
 * @returns The plain text representation of the invoice.
 */
export function renderText(invoice: Invoice): string {
  let text = `Invoice for ${invoice.client}\n`;
  text += 'Items:\n';
  invoice.items.forEach((item, index) => {
    text += `${index + 1}. ${item.description} - ${item.qty} x $${item.unitPrice.toFixed(2)}\n`;
  });
  text += `\nSubtotal: $${invoice.totals.subtotal.toFixed(2)}\n`;
  text += `Discount (${invoice.discount}%): $${invoice.totals.discountAmount.toFixed(2)}\n`;
  text += `Tax (${invoice.taxRate}%): $${invoice.totals.taxAmount.toFixed(2)}\n`;
  text += `Total: $${invoice.totals.total.toFixed(2)}\n`;
  return text;
}

/**
 * Exports line items as CSV.
 * @param invoice - The invoice to export.
 * @returns CSV string of line items.
 */
export function toCSV(invoice: Invoice): string {
  const headers = ['description', 'qty', 'unitPrice'];
  const rows = invoice.items.map(item => [item.description, item.qty, item.unitPrice].join(','));
  return [headers.join(','), ...rows].join('\n');
}