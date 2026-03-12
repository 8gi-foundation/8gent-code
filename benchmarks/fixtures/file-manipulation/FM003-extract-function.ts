/**
 * Fixture: FM003 - Extract Function
 *
 * Task: Extract the validation logic into a separate validateOrder function
 */

interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

interface Order {
  id: string;
  customerId: string;
  items: OrderItem[];
  status: "pending" | "confirmed" | "shipped" | "delivered";
  createdAt: Date;
}

export function processOrder(order: Order): { success: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validation logic to extract
  if (!order.id || order.id.length < 5) {
    errors.push("Invalid order ID");
  }

  if (!order.customerId) {
    errors.push("Customer ID is required");
  }

  if (!order.items || order.items.length === 0) {
    errors.push("Order must have at least one item");
  }

  for (const item of order.items) {
    if (item.quantity <= 0) {
      errors.push(`Invalid quantity for product ${item.productId}`);
    }
    if (item.price < 0) {
      errors.push(`Invalid price for product ${item.productId}`);
    }
  }

  const totalValue = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (totalValue > 10000) {
    errors.push("Order value exceeds maximum limit");
  }
  // End validation logic

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Process the order
  console.log(`Processing order ${order.id} for customer ${order.customerId}`);
  return { success: true, errors: [] };
}
