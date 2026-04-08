/**
 * Manages an LLM context window with a token budget.
 */
export class ContextWindow {
  private messages: { text: string; tokens: number }[];
  private currentTotal: number;
  private maxTokens: number;

  /**
   * Create a new context window with a maximum token budget.
   * @param maxTokens Maximum number of tokens allowed in the context window.
   */
  constructor(maxTokens: number) {
    this.messages = [];
    this.currentTotal = 0;
    this.maxTokens = maxTokens;
  }

  /**
   * Add a message to the context window, evicting the oldest if necessary.
   * @param message The message to add.
   */
  add(message: string): void {
    const newTokens = Math.ceil(message.length / 4);

    while (this.currentTotal + newTokens > this.maxTokens && this.messages.length > 0) {
      const oldest = this.messages.shift();
      this.currentTotal -= oldest.tokens;
    }

    if (this.currentTotal + newTokens <= this.maxTokens) {
      this.messages.push({ text: message, tokens: newTokens });
      this.currentTotal += newTokens;
    }
  }

  /**
   * Get the current messages in the context window.
   * @returns Array of messages.
   */
  getMessages(): string[] {
    return this.messages.map(m => m.text);
  }

  /**
   * Get the total estimated token count in the context window.
   * @returns Total token count.
   */
  tokenCount(): number {
    return this.currentTotal;
  }
}