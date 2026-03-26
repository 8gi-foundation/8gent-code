/**
 * Represents a tool call extracted from LLM response.
 */
interface ToolCall {
  name: string;
  arguments: object;
  id: string;
}

/**
 * Extracts tool calls from JSON blocks in the given text.
 * @param text - The raw text containing JSON blocks.
 * @returns An array of parsed ToolCall objects.
 */
function parse(text: string): ToolCall[] {
  const jsonBlocks = text.match(/