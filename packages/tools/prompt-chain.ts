/**
 * Chains prompts sequentially, passing outputs as inputs.
 */
export class PromptChain {
  /**
   * Ordered array of functions to execute in sequence.
   */
  steps: ((input: string) => Promise<string>)[];

  /**
   * Callback to be called after each step.
   */
  onStep?: (index: number, input: string, output: string) => void;

  /**
   * Creates a new PromptChain with the given steps.
   * @param steps Ordered array of functions to execute in sequence.
   */
  constructor(steps: ((input: string) => Promise<string>)[]) {
    this.steps = steps;
  }

  /**
   * Executes the chain with the given initial input and abort signal.
   * @param initialInput The initial input to the first step.
   * @param signal Optional abort signal to cancel the chain.
   * @returns The final output after all steps.
   */
  async run(initialInput: string, signal?: AbortSignal): Promise<string> {
    let input = initialInput;
    for (let i = 0; i < this.steps.length; i++) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const output = await this.steps[i](input);
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (this.onStep) {
        this.onStep(i, input, output);
      }
      input = output;
    }
    return input;
  }
}