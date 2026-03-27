/**
 * Creates a GitHub Actions workflow shell.
 * @param options - Workflow configuration
 * @returns Workflow object
 */
export function createWorkflow({ name, on = [], env = {} }) {
  return { name, on, env, jobs: [] };
}

/**
 * Adds a job to a workflow.
 * @param workflow - Workflow object
 * @param options - Job configuration
 */
export function addJob(workflow, { id, runsOn, steps }) {
  workflow.jobs.push({ id, runsOn, steps });
}

/**
 * Creates a checkout step.
 * @param options - Checkout options
 * @returns Step configuration
 */
export function stepCheckout(options = { fetchDepth: 1 }) {
  return {
    uses: 'actions/checkout@v4',
    with: { fetchDepth: options.fetchDepth }
  };
}

/**
 * Creates a node setup step.
 * @param version - Node version
 * @returns Step configuration
 */
export function stepSetupNode(version) {
  return {
    uses: 'actions/setup-node@v4',
    with: { nodeVersion: version }
  };
}

/**
 * Creates a cache step.
 * @param key - Cache key
 * @param paths - Paths to cache
 * @returns Step configuration
 */
export function stepCache(key, paths) {
  return {
    uses: 'actions/cache@v5',
    with: { key, paths: paths.join(' ') }
  };
}

/**
 * Renders workflow to YAML string.
 * @param workflow - Workflow object
 * @returns YAML string
 */
export function render(workflow) {
  const lines = [];
  lines.push(`name: ${workflow.name}`);
  lines.push('on:');
  workflow.on.forEach(event => lines.push(`  - ${event}`));
  lines.push('env:');
  Object.entries(workflow.env).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
  lines.push('jobs:');
  workflow.jobs.forEach(job => {
    lines.push(`  ${job.id}:`);
    lines.push(`    runs-on: ${job.runsOn}`);
    lines.push('    steps:');
    job.steps.forEach(step => {
      lines.push(`      - uses: ${step.uses}`);
      if (step.with) {
        lines.push('        with:');
        Object.entries(step.with).forEach(([k, v]) => lines.push(`          ${k}: ${v}`));
      }
    });
  });
  return lines.join('\n');
}