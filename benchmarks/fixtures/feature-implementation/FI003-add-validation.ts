/**
 * Fixture: FI003 - Add Schema Validation
 *
 * Task: Implement a type-safe schema validation system
 * Requirements:
 * - Define schemas using builder pattern
 * - Type inference from schema
 * - Detailed error messages
 * - Nested object validation
 * - Array validation
 * - Custom validators
 */

// Current: No validation
interface UserInput {
  name: string;
  email: string;
  age: number;
  preferences?: {
    theme: "light" | "dark";
    notifications: boolean;
  };
  tags?: string[];
}

function createUser(input: UserInput): void {
  // No validation - just assumes input is correct
  console.log("Creating user:", input);
}

// TODO: Implement schema validation system
//
// Usage should look like:
//
// const userSchema = schema.object({
//   name: schema.string().min(1).max(100),
//   email: schema.string().email(),
//   age: schema.number().min(0).max(150).integer(),
//   preferences: schema.object({
//     theme: schema.enum(['light', 'dark']),
//     notifications: schema.boolean(),
//   }).optional(),
//   tags: schema.array(schema.string()).optional(),
// });
//
// type User = InferType<typeof userSchema>;
//
// const result = userSchema.validate(input);
// if (result.success) {
//   // result.data is typed as User
// } else {
//   // result.errors contains validation errors
// }
//
// Features needed:
// 1. schema.string() - string validation with .min(), .max(), .email(), .regex()
// 2. schema.number() - number validation with .min(), .max(), .integer(), .positive()
// 3. schema.boolean() - boolean validation
// 4. schema.array(itemSchema) - array validation with .min(), .max()
// 5. schema.object({...}) - nested object validation
// 6. schema.enum([...]) - enum validation
// 7. .optional() - make any field optional
// 8. .nullable() - allow null
// 9. .custom(fn) - custom validation function
// 10. Type inference with InferType<>
