/**
 * Office Compound Engineering plugin utility for Claude Code, Codex, and more
 * @module OfficeCompoundPlugin
 */

/**
 * Represents a code plugin with configurable settings
 */
export class CodePlugin {
  /** Plugin name */
  public name: string;
  /** Plugin description */
  public description: string;
  /** Enable verbose logging */
  public verbose: boolean;

  /**
   * Create a new code plugin instance
   * @param options - Configuration options
   */
  constructor(options: { name: string; description: string; verbose?: boolean }) {
    this.name = options.name;
    this.description = options.description;
    this.verbose = options.verbose || false;
  }

  /**
   * Generate code based on plugin configuration
   * @param input - Input code or template
   * @returns Generated code
   */
  public generateCode(input: string): string {
    if (this.verbose) {
      console.log(`Generating code for plugin: ${this.name}`);
    }
    return `// Plugin: ${this.name}\n// Description: ${this.description}\n${input}`;
  }
}

/**
 * Create a new code plugin instance with default settings
 * @param name - Plugin name
 * @param description - Plugin description
 * @returns Configured CodePlugin instance
 */
export function createPlugin(name: string, description: string): CodePlugin {
  return new CodePlugin({ name, description });
}

/**
 * Format code with consistent indentation and line breaks
 * @param code - Code to format
 * @returns Formatted code
 */
export function formatCode(code: string): string {
  return code.replace(/\t/g, '  ').replace(/([{};])\s*/g, '$1\n  ');
}

/**
 * Handle errors with plugin-specific messages
 * @param error - Error object
 * @param pluginName - Name of the plugin
 * @throws {Error} With plugin context
 */
export function handlePluginError(error: Error, pluginName: string): never {
  throw new Error(`Plugin ${pluginName} error: ${error.message}`);
}