/**
 * Fixture: CR002 - Performance Code Review
 *
 * Task: Identify all performance issues and suggest optimizations
 * This code has multiple intentional performance problems
 */

interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  tags: string[];
}

interface Order {
  id: string;
  productIds: string[];
  total: number;
  date: Date;
}

// Performance issues to find:

// 1. Inefficient array operations
export function findProductsByCategory(products: Product[], category: string): Product[] {
  const result: Product[] = [];
  for (let i = 0; i < products.length; i++) {
    if (products[i].category === category) {
      result.push(products[i]);
    }
  }
  return result;
}

export function findProductsByCategories(products: Product[], categories: string[]): Product[] {
  let result: Product[] = [];
  for (const category of categories) {
    result = result.concat(findProductsByCategory(products, category));
  }
  return result;
}

// 2. N+1 query pattern
export function getOrdersWithProducts(
  orders: Order[],
  getProduct: (id: string) => Product
): Array<{ order: Order; products: Product[] }> {
  return orders.map((order) => ({
    order,
    products: order.productIds.map((id) => getProduct(id)),
  }));
}

// 3. Repeated computation
export function calculateOrderStats(orders: Order[]): {
  total: number;
  average: number;
  max: number;
  min: number;
} {
  return {
    total: orders.reduce((sum, o) => sum + o.total, 0),
    average: orders.reduce((sum, o) => sum + o.total, 0) / orders.length,
    max: Math.max(...orders.map((o) => o.total)),
    min: Math.min(...orders.map((o) => o.total)),
  };
}

// 4. Inefficient string operations
export function buildProductCatalog(products: Product[]): string {
  let catalog = "";
  for (const product of products) {
    catalog += `<div class="product">
      <h3>${product.name}</h3>
      <p>Price: $${product.price}</p>
      <p>Category: ${product.category}</p>
      <ul>${product.tags.map((t) => `<li>${t}</li>`).join("")}</ul>
    </div>`;
  }
  return catalog;
}

// 5. Unnecessary object creation in loop
export function processProducts(products: Product[]): void {
  for (const product of products) {
    const processor = {
      validate: () => product.price > 0,
      format: () => `${product.name}: $${product.price}`,
      log: () => console.log(product),
    };
    if (processor.validate()) {
      processor.log();
    }
  }
}

// 6. Inefficient search
export function findProduct(products: Product[], id: string): Product | undefined {
  for (let i = 0; i < products.length; i++) {
    if (products[i].id === id) {
      return products[i];
    }
  }
  return undefined;
}

export function findProducts(products: Product[], ids: string[]): Product[] {
  return ids.map((id) => findProduct(products, id)).filter((p): p is Product => p !== undefined);
}

// 7. Memory leak potential
const cache: Record<string, unknown> = {};

export function expensiveOperation(key: string, compute: () => unknown): unknown {
  if (!(key in cache)) {
    cache[key] = compute();
  }
  return cache[key];
}

// 8. Synchronous heavy computation blocking
export function analyzeProducts(products: Product[]): Map<string, number> {
  const categoryTotals = new Map<string, number>();

  for (const product of products) {
    // Simulating heavy computation
    for (let i = 0; i < 1000000; i++) {
      Math.random();
    }

    const current = categoryTotals.get(product.category) || 0;
    categoryTotals.set(product.category, current + product.price);
  }

  return categoryTotals;
}
