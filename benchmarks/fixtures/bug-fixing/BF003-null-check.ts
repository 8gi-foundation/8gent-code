/**
 * Fixture: BF003 - Missing Null Checks
 *
 * Bug: Multiple places where null/undefined values cause runtime errors
 * Task: Add proper null checks and handle edge cases
 */

interface Address {
  street: string;
  city: string;
  country: string;
  zipCode?: string;
}

interface Company {
  name: string;
  address?: Address;
}

interface Person {
  name: string;
  email?: string;
  company?: Company;
  tags?: string[];
}

// BUG: Crashes if person.email is undefined
export function getEmailDomain(person: Person): string {
  return person.email.split("@")[1];
}

// BUG: Crashes if company or address is undefined
export function getCompanyCity(person: Person): string {
  return person.company.address.city;
}

// BUG: Crashes if tags is undefined
export function getFirstTag(person: Person): string {
  return person.tags[0];
}

// BUG: Multiple potential null issues
export function formatPersonInfo(person: Person): string {
  const domain = getEmailDomain(person);
  const city = getCompanyCity(person);
  const tag = getFirstTag(person);

  return `${person.name} (${domain}) - ${city} - ${tag}`;
}

// BUG: Array method on potentially undefined value
export function countTagsWithPrefix(person: Person, prefix: string): number {
  return person.tags.filter((tag) => tag.startsWith(prefix)).length;
}

// Test data that will cause crashes
export const testData: Person[] = [
  { name: "Alice" }, // Missing email, company, tags
  { name: "Bob", email: "bob@example.com" }, // Missing company, tags
  { name: "Carol", company: { name: "Acme" } }, // Company has no address
  { name: "Dave", tags: [] }, // Empty tags array
];
