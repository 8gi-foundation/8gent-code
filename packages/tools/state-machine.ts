/**
 * Typed finite state machine for agent lifecycle management.
 * Zero external dependencies.
 */

export type StateId = string;
export type EventType = string;

export interface StateDefinition<TContext = unknown> {
  onEnter?: (context: TContext, event: MachineEvent | null) => void | Promise<void>;
  onExit?: (context: TContext, event: MachineEvent) => void | Promise<void>;
}

export interface MachineEvent<TPayload = unknown> {
  type: EventType;
  payload?: TPayload;
}

export interface HistoryEntry<TContext = unknown> {
  from: StateId;
  to: StateId;
  event: MachineEvent;
  timestamp: number;
  context: TContext;
}

export interface TransitionDefinition<TContext = unknown> {
  target: StateId;
  guard?: (context: TContext, event: MachineEvent) => boolean;
  action?: (context: TContext, event: MachineEvent) => TContext;
}

export interface MachineConfig<
  TStates extends string,
  TEvents extends string,
  TContext = unknown,
> {
  initial: TStates;
  context: TContext;
  states: Record<TStates, StateDefinition<TContext>>;
  transitions: Partial<
    Record<TStates, Partial<Record<TEvents, TransitionDefinition<TContext>>>>
  >;
  historyLimit?: number;
}

export class StateMachineError extends Error {
  constructor(
    message: string,
    public readonly state: StateId,
    public readonly event: MachineEvent,
  ) {
    super(message);
    this.name = "StateMachineError";
  }
}

export class StateMachine<
  TStates extends string = string,
  TEvents extends string = string,
  TContext = unknown,
> {
  private _current: TStates;
  private _context: TContext;
  private _history: HistoryEntry<TContext>[] = [];
  private readonly _historyLimit: number;
  private readonly _config: MachineConfig<TStates, TEvents, TContext>;

  constructor(config: MachineConfig<TStates, TEvents, TContext>) {
    this._config = config;
    this._current = config.initial;
    this._context = config.context;
    this._historyLimit = config.historyLimit ?? 100;
  }

  get current(): TStates {
    return this._current;
  }

  get context(): TContext {
    return this._context;
  }

  get history(): ReadonlyArray<HistoryEntry<TContext>> {
    return this._history;
  }

  /** Returns true if the machine is currently in the given state. */
  is(state: TStates): boolean {
    return this._current === state;
  }

  /** Returns true if the given event can fire from the current state. */
  can(eventType: TEvents): boolean {
    const stateDef = this._config.transitions[this._current];
    if (!stateDef) return false;
    const transition = stateDef[eventType];
    if (!transition) return false;
    if (transition.guard && !transition.guard(this._context, { type: eventType })) {
      return false;
    }
    return true;
  }

  /** Send an event to the machine. Returns true if a transition occurred. */
  async send(event: MachineEvent<unknown> & { type: TEvents }): Promise<boolean> {
    const stateDef = this._config.transitions[this._current];
    if (!stateDef) return false;

    const transition = stateDef[event.type as TEvents];
    if (!transition) return false;

    if (transition.guard && !transition.guard(this._context, event)) {
      return false;
    }

    const from = this._current;
    const to = transition.target as TStates;

    if (!this._config.states[to]) {
      throw new StateMachineError(
        `Transition target "${to}" is not a defined state`,
        from,
        event,
      );
    }

    // onExit of current state
    const currentStateDef = this._config.states[from];
    if (currentStateDef.onExit) {
      await currentStateDef.onExit(this._context, event);
    }

    // Apply action / update context
    if (transition.action) {
      this._context = transition.action(this._context, event);
    }

    // Record history before moving
    this._history.push({
      from,
      to,
      event,
      timestamp: Date.now(),
      context: this._context,
    });

    if (this._history.length > this._historyLimit) {
      this._history.shift();
    }

    // Move to target state
    this._current = to;

    // onEnter of new state
    const nextStateDef = this._config.states[to];
    if (nextStateDef.onEnter) {
      await nextStateDef.onEnter(this._context, event);
    }

    return true;
  }

  /** Returns the last N history entries (default: all). */
  recentHistory(n?: number): ReadonlyArray<HistoryEntry<TContext>> {
    if (n === undefined) return this._history;
    return this._history.slice(-n);
  }

  /** Reset the machine to its initial state and context. History is cleared. */
  reset(): void {
    this._current = this._config.initial;
    this._context = this._config.context;
    this._history = [];
  }

  /** Snapshot current state as a plain object for serialization. */
  snapshot(): { state: TStates; context: TContext; historyLength: number } {
    return {
      state: this._current,
      context: this._context,
      historyLength: this._history.length,
    };
  }
}
