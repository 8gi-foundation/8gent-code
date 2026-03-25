/**
 * Event Sourcing Store
 * Append-only event log that rebuilds state through replay.
 * Supports snapshots for fast recovery and time-travel to any point.
 */

export type EventType = string;

export interface Event<T = unknown> {
  id: string;
  type: EventType;
  payload: T;
  timestamp: number;
  sequence: number;
}

export interface Snapshot<S> {
  state: S;
  sequence: number;
  timestamp: number;
}

export type EventHandler<S, P = unknown> = (state: S, payload: P) => S;

export interface EventStoreOptions<S> {
  initialState: S;
  snapshotInterval?: number;
}

export class EventStore<S> {
  private events: Event[] = [];
  private snapshots: Snapshot<S>[] = [];
  private handlers = new Map<EventType, EventHandler<S, any>>();
  private initialState: S;
  private snapshotInterval: number;
  private sequence = 0;

  constructor(options: EventStoreOptions<S>) {
    this.initialState = structuredClone(options.initialState);
    this.snapshotInterval = options.snapshotInterval ?? 50;
  }

  on<P>(type: EventType, handler: EventHandler<S, P>): this {
    this.handlers.set(type, handler as EventHandler<S, unknown>);
    return this;
  }

  append<P>(type: EventType, payload: P): string {
    const event: Event<P> = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      payload,
      timestamp: Date.now(),
      sequence: ++this.sequence,
    };
    this.events.push(event);
    if (this.sequence % this.snapshotInterval === 0) {
      this._takeSnapshot();
    }
    return event.id;
  }

  getState(): S {
    return this._replayFrom(0, this.sequence);
  }

  getStateAt(sequence: number): S {
    return this._replayFrom(0, sequence);
  }

  getStateAtTime(timestamp: number): S {
    const seq = this._sequenceAtTime(timestamp);
    return this._replayFrom(0, seq);
  }

  getEvents(type?: EventType): Event[] {
    if (!type) return [...this.events];
    return this.events.filter((e) => e.type === type);
  }

  get currentSequence(): number {
    return this.sequence;
  }

  snapshot(): void {
    this._takeSnapshot();
  }

  reset(): void {
    this.events = [];
    this.snapshots = [];
    this.sequence = 0;
  }

  private _replayFrom(fromSeq: number, toSeq: number): S {
    const snap = this._nearestSnapshot(fromSeq, toSeq);
    let state: S = snap ? structuredClone(snap.state) : structuredClone(this.initialState);
    const startSeq = snap ? snap.sequence : 0;
    for (const event of this.events) {
      if (event.sequence <= startSeq) continue;
      if (event.sequence > toSeq) break;
      const handler = this.handlers.get(event.type);
      if (handler) state = handler(state, event.payload);
    }
    return state;
  }

  private _nearestSnapshot(fromSeq: number, toSeq: number): Snapshot<S> | null {
    let best: Snapshot<S> | null = null;
    for (const snap of this.snapshots) {
      if (snap.sequence >= fromSeq && snap.sequence <= toSeq) {
        if (!best || snap.sequence > best.sequence) best = snap;
      }
    }
    return best;
  }

  private _takeSnapshot(): void {
    const state = this._replayFrom(0, this.sequence);
    this.snapshots.push({ state, sequence: this.sequence, timestamp: Date.now() });
  }

  private _sequenceAtTime(timestamp: number): number {
    let seq = 0;
    for (const event of this.events) {
      if (event.timestamp <= timestamp) seq = event.sequence;
      else break;
    }
    return seq;
  }
}
