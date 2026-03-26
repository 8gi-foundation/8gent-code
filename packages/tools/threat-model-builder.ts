/**
 * Represents a STRIDE threat model.
 */
interface Model {
  components: Component[];
  nextComponentId: number;
  threats: Threat[];
}

/**
 * Represents a system component in the threat model.
 */
interface Component {
  id: string;
  name: string;
  type: string;
  dataFlows: string[];
  threats: Threat[];
}

/**
 * Represents a threat in the STRIDE model.
 */
interface Threat {
  stride: string;
  description: string;
  mitigation: string;
  risk: string;
}

/**
 * Adds a component to the model.
 * @param model - The threat model.
 * @param options - Component options.
 */
function addComponent(model: Model, { name, type, dataFlows }: { name: string; type: string; dataFlows: string[] }): void {
  const component: Component = {
    id: `comp-${model.nextComponentId++}`,
    name,
    type,
    dataFlows,
    threats: []
  };
  model.components.push(component);
}

/**
 * Adds a threat to a component in the model.
 * @param model - The threat model.
 * @param componentId - ID of the component.
 * @param options - Threat options.
 */
function addThreat(model: Model, componentId: string, { stride, description, mitigation, risk }: { stride: string; description: string; mitigation: string; risk: string }): void {
  const component = model.components.find(c => c.id === componentId);
  if (component) {
    component.threats.push({ stride, description, mitigation, risk });
  }
}

/**
 * Returns STRIDE categories.
 * @returns Array of STRIDE categories.
 */
function strideCategories(): string[] {
  return ['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'DoS', 'EoP'];
}

/**
 * Generates a risk matrix for the model.
 * @param model - The threat model.
 * @returns Risk matrix as a 2D array.
 */
function riskMatrix(model: Model): string[][] {
  const severity = ['Low', 'Medium', 'High'];
  const likelihood = ['Low', 'Medium', 'High'];
  const matrix: string[][] = Array(severity.length).fill(null).map(() => Array(likelihood.length).fill('0'));
  model.components.forEach(c => c.threats.forEach(t => {
    const s = severity.indexOf(t.risk);
    const l = likelihood.indexOf(t.risk);
    if (s !== -1 && l !== -1) matrix[s][l] = (parseInt(matrix[s][l]) + 1).toString();
  }));
  return [severity, ...matrix.map(row => [likelihood[0], ...row])];
}

/**
 * Renders a markdown report of the threat model.
 * @param model - The threat model.
 * @returns Markdown report.
 */
function renderReport(model: Model): string {
  let report = '# STRIDE Threat Model Report\n\n';
  model.components.forEach(component => {
    report += `## Component: ${component.name}\n`;
    report += `**Type**: ${component.type}\n`;
    report += '**Data Flows**:\n- ' + component.dataFlows.join('\n- ') + '\n';
    report += '**Threats**:\n';
    component.threats.forEach((threat, index) => {
      report += `### Threat ${index + 1}\n`;
      report += `**STRIDE**: ${threat.stride}\n`;
      report += `**Description**: ${threat.description}\n`;
      report += `**Mitigation**: ${threat.mitigation}\n`;
      report += `**Risk**: ${threat.risk}\n\n`;
    });
  });
  return report;
}

export { addComponent, addThreat, strideCategories, riskMatrix, renderReport };