/**
 * Deterministic Finite Automaton (DFA)
 *
 * Pattern matching and state machine transitions for agent conversation
 * flow control and input validation. Zero dependencies.
 */

export interface State {
  id: string;
  accepting: boolean;
  meta?: Record<string, unknown>;
}

export interface Transition {
  from: string;
  symbol: string;
  to: string;
}

export class DFAError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DFAError";
  }
}

export class DFA {
  private states = new Map<string, State>();
  private transitions = new Map<string, Map<string, string>>(); // from -> symbol -> to
  private startState: string | null = null;

  addState(id: string, accepting = false, meta?: Record<string, unknown>): this {
    this.states.set(id, { id, accepting, meta });
    if (!this.transitions.has(id)) {
      this.transitions.set(id, new Map());
    }
    return this;
  }

  setStart(id: string): this {
    if (!this.states.has(id)) throw new DFAError(`Unknown state: ${id}`);
    this.startState = id;
    return this;
  }

  addTransition(from: string, symbol: string, to: string): this {
    if (!this.states.has(from)) throw new DFAError(`Unknown state: ${from}`);
    if (!this.states.has(to)) throw new DFAError(`Unknown state: ${to}`);
    const map = this.transitions.get(from)!;
    if (map.has(symbol)) {
      throw new DFAError(`Transition conflict: (${from}, '${symbol}') already defined`);
    }
    map.set(symbol, to);
    return this;
  }

  /** Run a string through the DFA. Returns the final state id or null if rejected. */
  run(input: string): { accepted: boolean; finalState: string | null; trace: string[] } {
    if (this.startState === null) throw new DFAError("No start state set");
    let current = this.startState;
    const trace: string[] = [current];

    for (const ch of input) {
      const map = this.transitions.get(current);
      const next = map?.get(ch) ?? map?.get("*"); // "*" acts as wildcard
      if (next === undefined) {
        return { accepted: false, finalState: null, trace };
      }
      current = next;
      trace.push(current);
    }

    const finalState = this.states.get(current)!;
    return { accepted: finalState.accepting, finalState: current, trace };
  }

  /** Returns all reachable states from start. */
  reachable(): Set<string> {
    if (this.startState === null) return new Set();
    const visited = new Set<string>();
    const queue = [this.startState];
    while (queue.length) {
      const s = queue.shift()!;
      if (visited.has(s)) continue;
      visited.add(s);
      for (const next of this.transitions.get(s)?.values() ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    return visited;
  }

  /** Minimise: remove unreachable states and their transitions. */
  minimize(): this {
    const alive = this.reachable();
    for (const id of this.states.keys()) {
      if (!alive.has(id)) {
        this.states.delete(id);
        this.transitions.delete(id);
      }
    }
    // Remove transitions pointing to dead states
    for (const map of this.transitions.values()) {
      for (const [sym, to] of map.entries()) {
        if (!alive.has(to)) map.delete(sym);
      }
    }
    return this;
  }

  /** Build a DFA that recognises a literal string (exact match). */
  static fromLiteral(pattern: string): DFA {
    const dfa = new DFA();
    dfa.addState("s0");
    dfa.setStart("s0");
    for (let i = 0; i < pattern.length; i++) {
      dfa.addState(`s${i + 1}`, i === pattern.length - 1);
      dfa.addTransition(`s${i}`, pattern[i], `s${i + 1}`);
    }
    if (pattern.length === 0) {
      dfa.states.get("s0")!.accepting = true;
    }
    return dfa;
  }

  /** Build a DFA that accepts any string containing only chars in the given set. */
  static fromCharset(chars: string, minLen = 1): DFA {
    const dfa = new DFA();
    dfa.addState("dead");
    dfa.addState("ok", minLen === 0);
    dfa.setStart(minLen === 0 ? "ok" : "dead");

    if (minLen > 0) {
      for (const ch of new Set(chars)) {
        dfa.addTransition("dead", ch, "ok");
      }
    }
    for (const ch of new Set(chars)) {
      if (!dfa.transitions.get("ok")?.has(ch)) {
        dfa.addTransition("ok", ch, "ok");
      }
    }
    return dfa;
  }

  get stateCount(): number {
    return this.states.size;
  }
}
