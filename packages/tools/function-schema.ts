/**
 * Represents a function parameter with type information.
 */
interface FunctionParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

/**
 * Builds an OpenAI-compatible function schema from parameters.
 * @param name - Function name
 * @param description - Function description
 * @param params - Array of FunctionParam objects
 * @returns OpenAI function schema
 */
export function buildSchema(name: string, description: string, params: FunctionParam[]): any {
  return {
    name,
    description,
    parameters: {
      properties: params.reduce((acc, param) => {
        acc[param.name] = { type: param.type };
        return acc;
      }, {} as Record<string, { type: string }>),
      required: params.filter(p => p.required).map(p => p.name)
    }
  };
}

/**
 * Converts parameters to a Zod-compatible shape object.
 * @param params - Array of FunctionParam objects
 * @returns Zod shape object with type strings
 */
export function toZodShape(params: FunctionParam[]): Record<string, string> {
  return params.reduce((acc, param) => {
    acc[param.name] = `z.${param.type}()`;
    return acc;
  }, {} as Record<string, string>);
}

/**
 * Validates arguments against a schema.
 * @param args - Arguments to validate
 * @param schema - Schema to validate against
 * @throws Error if validation fails
 */
export function validate(args: any, schema: any): void {
  const { parameters } = schema;
  for (const paramName of parameters.required) {
    if (!(paramName in args)) {
      throw new Error(`Missing required parameter: ${paramName}`);
    }
    const paramType = parameters.properties[paramName].type;
    const argValue = args[paramName];
    if (typeof argValue !== paramType) {
      throw new Error(`Invalid type for ${paramName}: expected ${paramType}, got ${typeof argValue}`);
    }
  }
}