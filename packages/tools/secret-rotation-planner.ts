/**
 * Secret rotation planner interface.
 */
interface Planner {
  secrets: Secret[];
}

/**
 * Secret definition.
 */
interface Secret {
  name: string;
  type: string;
  lastRotated: Date;
  rotationDays: number;
}

/**
 * Adds a secret to the planner.
 * @param planner - The planner object.
 * @param secret - Secret details.
 */
function addSecret(planner: Planner, secret: { name: string; type: string; lastRotated: Date; rotationDays: number }): void {
  planner.secrets.push(secret);
}

/**
 * Finds secrets due for rotation.
 * @param planner - The planner object.
 * @param now - Current date (default: now).
 * @returns Secrets due for rotation.
 */
function dueForRotation(planner: Planner, now = new Date()): Secret[] {
  const result: Secret[] = [];
  for (const secret of planner.secrets) {
    const expiryDate = new Date(secret.lastRotated);
    expiryDate.setDate(expiryDate.getDate() + secret.rotationDays);
    const diffMs = expiryDate.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays <= 0 || (diffDays > 0 && diffDays <= 7)) {
      result.push(secret);
    }
  }
  return result;
}

/**
 * Updates a secret's last rotation date.
 * @param planner - The planner object.
 * @param name - Secret name.
 * @param date - New rotation date (default: now).
 */
function markRotated(planner: Planner, name: string, date = new Date()): void {
  for (const secret of planner.secrets) {
    if (secret.name === name) {
      secret.lastRotated = date;
      break;
    }
  }
}

/**
 * Returns rotation procedure for a secret type.
 * @param secretType - Type of secret.
 * @returns Step-by-step procedure.
 */
function procedure(secretType: string): string[] {
  const steps: { [type: string]: string[] } = {
    'api': ['Revoke old API key', 'Generate new API key', 'Update in configuration'],
    'ssh': ['Revoke old SSH key', 'Generate new SSH key', 'Add to authorized keys'],
    'database': ['Backup current credentials', 'Rotate database password', 'Update in DB config'],
  };
  return steps[secretType] || ['No procedure found for this type'];
}

/**
 * Renders a dashboard of secret expiry timelines.
 * @param planner - The planner object.
 * @returns Dashboard string with urgency indicators.
 */
function renderDashboard(planner: Planner): string {
  const now = new Date();
  let dashboard = 'Secret Rotation Dashboard\n';
  for (const secret of planner.secrets) {
    const expiryDate = new Date(secret.lastRotated);
    expiryDate.setDate(expiryDate.getDate() + secret.rotationDays);
    const diffMs = expiryDate.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    let urgency = 'OK';
    if (diffDays <= 0) urgency = 'Urgent';
    else if (diffDays <= 7) urgency = 'Soon';
    dashboard += `- ${secret.name} (Expires: ${expiryDate.toDateString()}) - ${urgency}\n`;
  }
  return dashboard;
}

export { addSecret, dueForRotation, markRotated, procedure, renderDashboard };