/**
 * Fixture: CR003 - Code Smells Review
 *
 * Task: Identify code smells and refactoring opportunities
 * This code has multiple intentional code quality issues
 */

// Code smells to find:

// 1. God function - does too many things
export function processUserData(
  userId: string,
  action: string,
  data: Record<string, unknown>
): unknown {
  // Validate user
  if (!userId || userId.length < 3) {
    return { error: "Invalid user ID" };
  }

  // Check action
  if (action === "create") {
    // Validate create data
    if (!data.name || !data.email) {
      return { error: "Name and email required" };
    }
    // Create user logic
    const user = {
      id: userId,
      name: data.name,
      email: data.email,
      createdAt: new Date(),
    };
    // Save to database (simulated)
    console.log("Creating user:", user);
    // Send welcome email
    console.log("Sending welcome email to:", data.email);
    // Track analytics
    console.log("Analytics: user_created");
    return user;
  } else if (action === "update") {
    // Update logic
    console.log("Updating user:", userId, data);
    return { updated: true };
  } else if (action === "delete") {
    // Delete logic
    console.log("Deleting user:", userId);
    // Send goodbye email
    console.log("Sending goodbye email");
    // Track analytics
    console.log("Analytics: user_deleted");
    return { deleted: true };
  } else if (action === "verify") {
    // Verification logic
    console.log("Verifying user:", userId);
    return { verified: true };
  }

  return { error: "Unknown action" };
}

// 2. Magic numbers and strings
export function calculatePrice(basePrice: number, quantity: number, userType: string): number {
  let total = basePrice * quantity;

  if (quantity > 10) {
    total = total * 0.9;
  }
  if (quantity > 50) {
    total = total * 0.85;
  }
  if (quantity > 100) {
    total = total * 0.8;
  }

  if (userType === "premium") {
    total = total * 0.95;
  }
  if (userType === "vip") {
    total = total * 0.9;
  }

  if (total > 1000) {
    total = total - 50;
  }

  return total;
}

// 3. Deep nesting
export function validateOrder(order: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (order) {
    if (order.items) {
      if (Array.isArray(order.items)) {
        if (order.items.length > 0) {
          for (const item of order.items as Array<Record<string, unknown>>) {
            if (item) {
              if (item.productId) {
                if (typeof item.productId === "string") {
                  if (item.quantity) {
                    if (typeof item.quantity === "number") {
                      if (item.quantity > 0) {
                        // Item is valid
                      } else {
                        errors.push("Quantity must be positive");
                      }
                    } else {
                      errors.push("Quantity must be a number");
                    }
                  } else {
                    errors.push("Quantity is required");
                  }
                } else {
                  errors.push("Product ID must be a string");
                }
              } else {
                errors.push("Product ID is required");
              }
            } else {
              errors.push("Item cannot be null");
            }
          }
        } else {
          errors.push("Order must have items");
        }
      } else {
        errors.push("Items must be an array");
      }
    } else {
      errors.push("Items are required");
    }
  } else {
    errors.push("Order cannot be null");
  }

  return errors;
}

// 4. Duplicate code
export function formatUserForApi(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: user.id,
    fullName: `${user.firstName} ${user.lastName}`,
    email: user.email?.toString().toLowerCase(),
    createdAt: user.createdAt ? new Date(user.createdAt as string).toISOString() : null,
    status: user.active ? "active" : "inactive",
  };
}

export function formatAdminForApi(admin: Record<string, unknown>): Record<string, unknown> {
  return {
    id: admin.id,
    fullName: `${admin.firstName} ${admin.lastName}`,
    email: admin.email?.toString().toLowerCase(),
    createdAt: admin.createdAt ? new Date(admin.createdAt as string).toISOString() : null,
    status: admin.active ? "active" : "inactive",
    role: admin.role,
    permissions: admin.permissions,
  };
}

// 5. Long parameter list
export function createNotification(
  userId: string,
  title: string,
  body: string,
  type: string,
  priority: string,
  channel: string,
  scheduledAt: Date | null,
  expiresAt: Date | null,
  metadata: Record<string, unknown>,
  tags: string[],
  silent: boolean
): void {
  console.log("Creating notification:", {
    userId,
    title,
    body,
    type,
    priority,
    channel,
    scheduledAt,
    expiresAt,
    metadata,
    tags,
    silent,
  });
}

// 6. Boolean flag arguments
export function fetchData(
  url: string,
  useCache: boolean,
  includeHeaders: boolean,
  retry: boolean,
  verbose: boolean
): Promise<unknown> {
  if (verbose) console.log("Fetching:", url);
  if (useCache) console.log("Using cache");
  if (retry) console.log("Will retry on failure");

  return fetch(url).then((r) => {
    if (includeHeaders) {
      return { data: r.json(), headers: Object.fromEntries(r.headers) };
    }
    return r.json();
  });
}
