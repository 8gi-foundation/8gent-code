/**
 * metric-collector.ts
 * Runtime metric collection: counters, gauges, histograms with label support.
 * Export formats: JSON and Prometheus text.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(",");
}

function prometheusLabels(labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

// ---------------------------------------------------------------------------
// Counter - monotonically increasing value
// ---------------------------------------------------------------------------
class Counter {
  private values = new Map<string, number>();
  readonly name: string;
  readonly help: string;

  constructor(name: string, help = "") {
    this.name = name;
    this.help = help;
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (amount < 0) throw new Error("Counter.inc: amount must be >= 0");
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  toJSON(): object {
    return { name: this.name, type: "counter", values: Object.fromEntries(this.values) };
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.values) {
      const lbl = key ? `{${key}}` : "";
      lines.push(`${this.name}${lbl} ${val}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Gauge - arbitrary numeric value (up/down/set)
// ---------------------------------------------------------------------------
class Gauge {
  private values = new Map<string, number>();
  readonly name: string;
  readonly help: string;

  constructor(name: string, help = "") {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), value);
  }

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  dec(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) - amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  toJSON(): object {
    return { name: this.name, type: "gauge", values: Object.fromEntries(this.values) };
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, val] of this.values) {
      const lbl = key ? `{${key}}` : "";
      lines.push(`${this.name}${lbl} ${val}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Histogram - distribution of values over configurable buckets
// ---------------------------------------------------------------------------
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramData {
  buckets: Map<number, number>; // upper bound -> count
  sum: number;
  count: number;
}

class Histogram {
  private data = new Map<string, HistogramData>();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];

  constructor(name: string, help = "", buckets: number[] = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    if (!this.data.has(key)) {
      const bmap = new Map<number, number>();
      for (const b of this.buckets) bmap.set(b, 0);
      bmap.set(Infinity, 0);
      this.data.set(key, { buckets: bmap, sum: 0, count: 0 });
    }
    const d = this.data.get(key)!;
    d.sum += value;
    d.count += 1;
    for (const b of this.buckets) {
      if (value <= b) d.buckets.set(b, (d.buckets.get(b) ?? 0) + 1);
    }
    d.buckets.set(Infinity, d.count);
  }

  toJSON(): object {
    const result: Record<string, object> = {};
    for (const [key, d] of this.data) {
      result[key || "__default__"] = {
        buckets: Object.fromEntries(
          [...d.buckets.entries()].map(([b, c]) => [b === Infinity ? "+Inf" : b, c])
        ),
        sum: d.sum,
        count: d.count,
      };
    }
    return { name: this.name, type: "histogram", values: result };
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, d] of this.data) {
      const baseLbl = key ? `,${key}` : "";
      for (const [bound, cnt] of d.buckets) {
        const le = bound === Infinity ? "+Inf" : String(bound);
        lines.push(`${this.name}_bucket{le="${le}"${baseLbl}} ${cnt}`);
      }
      lines.push(`${this.name}_sum${key ? `{${key}}` : ""} ${d.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ""} ${d.count}`);
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// MetricCollector - registry for all metrics
// ---------------------------------------------------------------------------
export class MetricCollector {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  counter(name: string, help = ""): Counter {
    if (!this.counters.has(name)) this.counters.set(name, new Counter(name, help));
    return this.counters.get(name)!;
  }

  gauge(name: string, help = ""): Gauge {
    if (!this.gauges.has(name)) this.gauges.set(name, new Gauge(name, help));
    return this.gauges.get(name)!;
  }

  histogram(name: string, help = "", buckets?: number[]): Histogram {
    if (!this.histograms.has(name)) this.histograms.set(name, new Histogram(name, help, buckets));
    return this.histograms.get(name)!;
  }

  toJSON(): object {
    return {
      counters: [...this.counters.values()].map((c) => c.toJSON()),
      gauges: [...this.gauges.values()].map((g) => g.toJSON()),
      histograms: [...this.histograms.values()].map((h) => h.toJSON()),
    };
  }

  toPrometheus(): string {
    const parts: string[] = [];
    for (const c of this.counters.values()) parts.push(c.toPrometheus());
    for (const g of this.gauges.values()) parts.push(g.toPrometheus());
    for (const h of this.histograms.values()) parts.push(h.toPrometheus());
    return parts.join("\n\n");
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

export { Counter, Gauge, Histogram };
export type { Labels };
