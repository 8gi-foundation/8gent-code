/**
 * Fixture: DOC002 - Generate Documentation for State Machine
 *
 * Task: Generate comprehensive documentation including:
 * - Architecture overview
 * - State transition diagrams (mermaid format)
 * - API documentation with examples
 * - Common patterns and use cases
 */

type StateValue = string | Record<string, StateValue>;

interface StateNodeConfig<TContext, TEvent extends { type: string }> {
  initial?: string;
  states?: Record<string, StateNodeConfig<TContext, TEvent>>;
  on?: Record<string, string | TransitionConfig<TContext, TEvent>>;
  entry?: Action<TContext, TEvent> | Action<TContext, TEvent>[];
  exit?: Action<TContext, TEvent> | Action<TContext, TEvent>[];
  always?: TransitionConfig<TContext, TEvent>[];
  after?: Record<number, string | TransitionConfig<TContext, TEvent>>;
}

interface TransitionConfig<TContext, TEvent extends { type: string }> {
  target?: string;
  cond?: Guard<TContext, TEvent>;
  actions?: Action<TContext, TEvent> | Action<TContext, TEvent>[];
}

type Action<TContext, TEvent> = (context: TContext, event: TEvent) => void | TContext | Partial<TContext>;

type Guard<TContext, TEvent> = (context: TContext, event: TEvent) => boolean;

interface MachineConfig<TContext, TEvent extends { type: string }> {
  id: string;
  initial: string;
  context: TContext;
  states: Record<string, StateNodeConfig<TContext, TEvent>>;
  on?: Record<string, string | TransitionConfig<TContext, TEvent>>;
}

interface State<TContext, TEvent extends { type: string }> {
  value: StateValue;
  context: TContext;
  matches: (value: string) => boolean;
  can: (event: TEvent["type"]) => boolean;
  changed: boolean;
  done: boolean;
}

type Listener<TContext, TEvent extends { type: string }> = (state: State<TContext, TEvent>) => void;

class StateMachine<TContext, TEvent extends { type: string }> {
  private config: MachineConfig<TContext, TEvent>;
  private currentState: State<TContext, TEvent>;
  private listeners: Set<Listener<TContext, TEvent>> = new Set();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(config: MachineConfig<TContext, TEvent>) {
    this.config = config;
    this.currentState = this.createState(config.initial, config.context, false);
    this.executeEntryActions(config.initial);
    this.scheduleDelayedTransitions(config.initial);
  }

  private createState(value: string, context: TContext, changed: boolean): State<TContext, TEvent> {
    return {
      value,
      context,
      changed,
      done: value === "done" || value === "final",
      matches: (v: string) => value === v || value.startsWith(`${v}.`),
      can: (eventType: TEvent["type"]) => {
        const stateConfig = this.getStateConfig(value);
        return !!(stateConfig?.on?.[eventType] || this.config.on?.[eventType]);
      },
    };
  }

  private getStateConfig(statePath: string): StateNodeConfig<TContext, TEvent> | undefined {
    const parts = statePath.split(".");
    let current: StateNodeConfig<TContext, TEvent> | undefined = this.config.states[parts[0]];

    for (let i = 1; i < parts.length && current; i++) {
      current = current.states?.[parts[i]];
    }

    return current;
  }

  private executeEntryActions(statePath: string): void {
    const stateConfig = this.getStateConfig(statePath);
    if (!stateConfig?.entry) return;

    const actions = Array.isArray(stateConfig.entry) ? stateConfig.entry : [stateConfig.entry];

    for (const action of actions) {
      const result = action(this.currentState.context, { type: "ENTRY" } as TEvent);
      if (result && typeof result === "object") {
        this.currentState = this.createState(
          this.currentState.value as string,
          { ...this.currentState.context, ...result },
          true
        );
      }
    }
  }

  private executeExitActions(statePath: string): void {
    const stateConfig = this.getStateConfig(statePath);
    if (!stateConfig?.exit) return;

    const actions = Array.isArray(stateConfig.exit) ? stateConfig.exit : [stateConfig.exit];

    for (const action of actions) {
      action(this.currentState.context, { type: "EXIT" } as TEvent);
    }
  }

  private scheduleDelayedTransitions(statePath: string): void {
    const stateConfig = this.getStateConfig(statePath);
    if (!stateConfig?.after) return;

    for (const [delay, transition] of Object.entries(stateConfig.after)) {
      const timerId = setTimeout(() => {
        this.transition({ type: `AFTER_${delay}` } as TEvent);
      }, Number(delay));

      this.timers.set(`${statePath}_${delay}`, timerId);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private resolveTransition(
    transition: string | TransitionConfig<TContext, TEvent>,
    event: TEvent
  ): { target: string; actions: Action<TContext, TEvent>[] } | null {
    if (typeof transition === "string") {
      return { target: transition, actions: [] };
    }

    if (transition.cond && !transition.cond(this.currentState.context, event)) {
      return null;
    }

    const actions = transition.actions
      ? Array.isArray(transition.actions)
        ? transition.actions
        : [transition.actions]
      : [];

    return { target: transition.target || (this.currentState.value as string), actions };
  }

  send(event: TEvent): State<TContext, TEvent> {
    return this.transition(event);
  }

  private transition(event: TEvent): State<TContext, TEvent> {
    const currentValue = this.currentState.value as string;
    const stateConfig = this.getStateConfig(currentValue);

    let transitionConfig = stateConfig?.on?.[event.type] || this.config.on?.[event.type];

    if (!transitionConfig) {
      return this.currentState;
    }

    const resolved = this.resolveTransition(transitionConfig, event);
    if (!resolved) {
      return this.currentState;
    }

    const { target, actions } = resolved;

    if (target !== currentValue) {
      this.clearTimers();
      this.executeExitActions(currentValue);
    }

    let newContext = this.currentState.context;
    for (const action of actions) {
      const result = action(newContext, event);
      if (result && typeof result === "object") {
        newContext = { ...newContext, ...result };
      }
    }

    this.currentState = this.createState(target, newContext, target !== currentValue);

    if (target !== currentValue) {
      this.executeEntryActions(target);
      this.scheduleDelayedTransitions(target);
    }

    this.notifyListeners();
    return this.currentState;
  }

  getState(): State<TContext, TEvent> {
    return this.currentState;
  }

  subscribe(listener: Listener<TContext, TEvent>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.currentState);
    }
  }

  stop(): void {
    this.clearTimers();
    this.listeners.clear();
  }
}

function createMachine<TContext, TEvent extends { type: string }>(
  config: MachineConfig<TContext, TEvent>
): StateMachine<TContext, TEvent> {
  return new StateMachine(config);
}

export {
  StateMachine,
  createMachine,
  MachineConfig,
  StateNodeConfig,
  TransitionConfig,
  State,
  Action,
  Guard,
};
