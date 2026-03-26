/**
 * Tool definition interface.
 */
interface Tool {
  name: string;
  description: string;
  schema: object;
  handler: any;
}

/**
 * OpenAI-compatible tool interface.
 */
interface OpenAITool {
  name: string;
  description: string;
  function: {
    parameters: {
      schema: object;
    };
  };
}

/**
 * Registry for LLM tool definitions with validation.
 */
export class ToolRegistry {
  /**
   * Map of tool names to tool definitions.
   * @private
   */
  private tools = new Map<string, Tool>();

  /**
   * Register a new tool with schema validation.
   * @param tool - Tool definition with name, description, schema, and handler.
   */
  register(tool: Tool): void {
    if (!tool.name || !tool.description || !tool.schema || !tool.handler) {
      throw new Error('Tool must have name, description, schema, and handler');
    }
    if (typeof tool.schema !== 'object') {
      throw new Error('Schema must be an object');
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Retrieve the handler for a tool by name.
   * @param name - Name of the tool.
   * @returns The handler function.
   */
  get(name: string): any {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.handler;
  }

  /**
   * Convert registered tools to OpenAI-compatible format.
   * @returns Array of OpenAI tool definitions.
   */
  toOpenAITools(): OpenAITool[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      function: {
        parameters: {
          schema: tool.schema
        }
      }
    }));
  }
}