/**
 * Slot configuration for state machine.
 */
interface Slot {
  name: string;
  type: 'regex' | 'function';
  required: boolean;
  pattern?: string;
  extractor?: (input: string) => any;
}

/**
 * Transition configuration for state machine.
 */
interface Transition {
  condition: string | ((input: string) => boolean);
  targetState: string;
}

/**
 * State configuration for state machine.
 */
interface State {
  name: string;
  prompt: string;
  slots: Slot[];
  transitions: Transition[];
  context: { [key: string]: any };
}

/**
 * Conversation machine.
 */
interface Machine {
  states: { [key: string]: State };
}

/**
 * Define a state in the conversation machine.
 * @param machine - The machine object.
 * @param config - State configuration.
 */
function defineState(machine: Machine, config: { name: string; prompt: string; slots: Slot[]; transitions: Transition[] }): void {
  machine.states[config.name] = {
    name: config.name,
    prompt: config.prompt,
    slots: config.slots,
    transitions: config.transitions,
    context: {}
  };
}

/**
 * Transition to the next state based on user input.
 * @param machine - The machine object.
 * @param currentState - Current state name.
 * @param userInput - User input.
 * @returns Next state name or null if no transition found.
 */
function transition(machine: Machine, currentState: string, userInput: string): string | null {
  const state = machine.states[currentState];
  for (const trans of state.transitions) {
    let matches = false;
    if (typeof trans.condition === 'string') {
      matches = new RegExp(trans.condition).test(userInput);
    } else {
      matches = trans.condition(userInput);
    }
    if (matches) {
      return trans.targetState;
    }
  }
  return null;
}

/**
 * Fill slots with values extracted from user input.
 * @param state - Current state.
 * @param userInput - User input.
 */
function fillSlots(state: State, userInput: string): void {
  for (const slot of state.slots) {
    let value: any = null;
    if (slot.type === 'regex' && slot.pattern) {
      const match = userInput.match(new RegExp(slot.pattern));
      value = match ? match[1] : null;
    } else if (slot.type === 'function' && slot.extractor) {
      value = slot.extractor(userInput);
    }
    if (value !== null) {
      state.context[slot.name] = value;
    }
  }
}

/**
 * Check if all required slots are filled.
 * @param state - Current state.
 * @returns True if all required slots are filled.
 */
function isComplete(state: State): boolean {
  return state.slots.every(slot => slot.required ? state.context[slot.name] !== undefined : true);
}

/**
 * Render ASCII diagram of the machine states and transitions.
 * @param machine - The machine object.
 * @returns ASCII diagram as a string.
 */
function renderDiagram(machine: Machine): string {
  const lines: string[] = [];
  for (const stateName in machine.states) {
    const state = machine.states[stateName];
    lines.push(`${state.name} [${state.prompt}]`);
    for (const trans of state.transitions) {
      lines.push(`  -> ${trans.targetState} if ${typeof trans.condition === 'string' ? trans.condition : 'function'}`);
    }
  }
  return lines.join('\n');
}

export { defineState, transition, fillSlots, isComplete, renderDiagram };