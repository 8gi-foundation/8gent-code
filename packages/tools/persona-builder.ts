/**
 * Persona interface
 */
interface Persona {
  name: string;
  age: number;
  role: string;
  goals: string[];
  pains: string[];
  motivations: string[];
  channels: string[];
}

/**
 * Builds a persona object from input data
 * @param params - Persona parameters
 * @returns Constructed persona
 */
export function buildPersona(params: { name: string; age: number; role: string; goals: string[]; pains: string[]; motivations: string[]; channels: string[] }): Persona {
  return { ...params };
}

/**
 * Renders persona as ASCII card
 * @param persona - Persona object
 * @returns Formatted ASCII string
 */
export function renderCard(persona: Persona): string {
  const lines = [
    `__________________________`,
    `| Name: ${persona.name.padEnd(16)}`,
    `| Age: ${persona.age.toString().padEnd(16)}`,
    `| Role: ${persona.role.padEnd(16)}`,
    `|_________________________|`,
    `| Goals:`,
    ...persona.goals.map(g => `| - ${g}`),
    `| Pains:`,
    ...persona.pains.map(p => `| - ${p}`),
    `| Motivations:`,
    ...persona.motivations.map(m => `| - ${m}`),
    `| Channels:`,
    ...persona.channels.map(c => `| - ${c}`),
    `__________________________`
  ];
  return lines.join('\n');
}

/**
 * Compares two personas
 * @param a - First persona
 * @param b - Second persona
 * @returns Shared and divergent attributes
 */
export function comparePersonas(a: Persona, b: Persona): { shared: { goals: string[]; pains: string[] }; divergent: { goals: string[]; pains: string[] } } {
  const sharedGoals = [...new Set(a.goals.filter(g => b.goals.includes(g)))];
  const sharedPains = [...new Set(a.pains.filter(p => b.pains.includes(p)))];
  const divergentGoals = [...new Set([...a.goals, ...b.goals].filter(g => !sharedGoals.includes(g)))];
  const divergentPains = [...new Set([...a.pains, ...b.pains].filter(p => !sharedPains.includes(p)))];
  return { shared: { goals: sharedGoals, pains: sharedPains }, divergent: { goals: divergentGoals, pains: divergentPains } };
}

/**
 * Exports persona as JSON compatible object
 * @param persona - Persona object
 * @returns Clean JSON structure
 */
export function exportJSON(persona: Persona): { [key: string]: any } {
  return { ...persona };
}