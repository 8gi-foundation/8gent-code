/**
 * Fixture: FM001 - Basic File Edit
 *
 * Task: Add input validation to the createUser function
 */

interface User {
  id: string;
  name: string;
  email: string;
  age: number;
}

export function createUser(name: string, email: string, age: number): User {
  return {
    id: crypto.randomUUID(),
    name,
    email,
    age,
  };
}

export function deleteUser(id: string): boolean {
  // Stub implementation
  console.log(`Deleting user ${id}`);
  return true;
}
