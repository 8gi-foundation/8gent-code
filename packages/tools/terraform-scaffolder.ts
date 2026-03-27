/**
 * Generates Terraform module scaffolding with main.tf, variables.tf, outputs.tf
 */
export interface Resource {
  type: string;
  name: string;
  config: Record<string, any>;
}

export interface Variable {
  name: string;
  type: string;
  description: string;
  default?: any;
}

export interface Output {
  name: string;
  value: string;
  description?: string;
}

/**
 * Generates scaffold for Terraform module
 * @param module Module name
 * @param resources List of resources
 * @param variables List of variables
 * @param outputs List of outputs
 * @returns File map with tf content
 */
export function scaffold(
  module: string,
  resources: Resource[],
  variables: Variable[],
  outputs: Output[]
): Record<string, string> {
  return {
    main: resources.map(r => resource(r.type, r.name, r.config)).join('\n\n'),
    variables: variables.map(v => variable(v.name, v.type, v.description, v.default)).join('\n\n'),
    outputs: outputs.map(o => output(o.name, o.value, o.description)).join('\n\n')
  };
}

/**
 * Generates Terraform resource block
 * @param type Resource type
 * @param name Resource name
 * @param config Resource configuration
 * @returns Formatted resource block
 */
export function resource(type: string, name: string, config: Record<string, any>): string {
  return `resource "${type}" "${name}" {\n${Object.entries(config)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
    .join('\n')}\n}`;
}

/**
 * Generates Terraform variable block
 * @param name Variable name
 * @param type Variable type
 * @param description Variable description
 * @param default Variable default value
 * @returns Formatted variable block
 */
export function variable(
  name: string,
  type: string,
  description: string,
  default?: any
): string {
  return `variable "${name}" {\n  type = ${type}\n  description = "${description}"${
    default !== undefined ? `\n  default = ${JSON.stringify(default)}` : ''
  }\n}`;
}

/**
 * Generates Terraform output block
 * @param name Output name
 * @param value Output value
 * @param description Output description
 * @returns Formatted output block
 */
export function output(name: string, value: string, description?: string): string {
  return `output "${name}" {\n  value = ${value}${
    description ? `\n  description = "${description}"` : ''
  }\n}`;
}

/**
 * Renders module files from scaffold
 * @param scaffold Generated scaffold
 * @returns Rendered module files
 */
export function renderModule(scaffold: Record<string, string>): {
  main: string;
  variables: string;
  outputs: string;
} {
  return {
    main: scaffold.main,
    variables: scaffold.variables,
    outputs: scaffold.outputs
  };
}