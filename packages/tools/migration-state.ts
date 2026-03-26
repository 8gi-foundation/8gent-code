/**
 * Migration interface representing a database migration
 */
type Migration = {
  id: string;
  name: string;
  up: string;
  down: string;
};

/**
 * MigrationState tracking applied migration IDs
 */
type MigrationState = string[];

/**
 * Check if migrations have unique IDs
 */
function isValid(migrations: Migration[]): boolean {
  const ids = new Set(migrations.map(m => m.id));
  return ids.size === migrations.length;
}

/**
 * Get pending migrations not in applied state
 */
function getPending(migrations: Migration[], applied: MigrationState): Migration[] {
  return migrations.filter(m => !applied.includes(m.id));
}

/**
 * Add migration ID to applied state
 */
function markApplied(id: string, applied: MigrationState): MigrationState {
  return [...applied, id];
}

export { Migration, MigrationState, isValid, getPending, markApplied };