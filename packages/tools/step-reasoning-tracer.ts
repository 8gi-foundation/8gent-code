/**
 * Type definition for a reasoning step.
 */
type Step = {
  thought: string;
  action: string;
  observation: string;
  confidence: number;
};

/**
 * Adds a reasoning step to the trace.
 * @param trace - The trace object to add the step to.
 * @param step - The step object containing thought, action, observation, and confidence.
 */
function addStep(trace: { steps: Step[] }, step: Step): void {
  trace.steps.push(step);
}

/**
 * Validates the trace to ensure each step has an observation before the next thought.
 * @param trace - The trace object to validate.
 * @returns True if valid, false otherwise.
 */
function validate(trace: { steps: Step[] }): boolean {
  for (let i = 0; i < trace.steps.length - 1; i++) {
    const current = trace.steps[i];
    const next = trace.steps[i + 1];
    if (!current.observation || !next.thought) {
      return false;
    }
  }
  return true;
}

/**
 * Rolls back the trace to the specified step index.
 * @param trace - The trace object to modify.
 * @param stepIndex - The index to roll back to.
 */
function backtrack(trace: { steps: Step[] }, stepIndex: number): void {
  if (stepIndex >= 0 && stepIndex < trace.steps.length) {
    trace.steps = trace.steps.slice(0, stepIndex + 1);
  }
}

/**
 * Adds a final answer to the trace.
 * @param trace - The trace object to add the answer to.
 * @param answer - The final answer text.
 * @param confidence - The confidence score for the answer.
 */
function finalAnswer(trace: { steps: Step[] }, answer: string, confidence: number): void {
  addStep(trace, {
    thought: 'Final Answer',
    action: answer,
    observation: '',
    confidence: confidence
  });
}

/**
 * Renders the trace as a numbered list with confidence scores.
 * @param trace - The trace object to render.
 * @returns A string representation of the trace.
 */
function renderTrace(trace: { steps: Step[] }): string {
  return trace.steps.map((step, index) => 
    `${index + 1}. Thought: ${step.thought}, Action: ${step.action}, Observation: ${step.observation}, Confidence: ${step.confidence}`
  ).join('\n');
}

export { addStep, validate, backtrack, finalAnswer, renderTrace };