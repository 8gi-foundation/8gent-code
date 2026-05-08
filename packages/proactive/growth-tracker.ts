/**
 * 8gent Growth Tracker
 *
 * Tracks GitHub stars, npm downloads, and website analytics.
 * Outputs a weekly growth report and identifies top adoption channels.
 *
 * Usage:
 *   import { generateWeeklyReport } from './growth-tracker.ts'
 *   const report = await generateWeeklyReport()
 */

// -- Types --

export interface GrowthSnapshot {
  date: string; // ISO date
  githubStars: number;
  npmDownloadsWeekly: number;
  websiteVisits: number;
  source: "github" | "npm" | "analytics" | "manual";
}

export interface ChannelMetrics {
  channel: string;
  current: number;
  previous: number;
  delta: number;
  growthPct: number;
}

export interface WeeklyReport {
  generatedAt: string;
  period: { from: string; to: string };
  channels: ChannelMetrics[];
  topChannel: string;
  summary: string;
}

// -- Data fetchers --

async function fetchGitHubStars(owner: string, repo: string): Promise<number> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) return 0;
  const data = (await res.json()) as { stargazers_count?: number };
  return data.stargazers_count ?? 0;
}

async function fetchNpmWeeklyDownloads(pkg: string): Promise<number> {
  const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);
  if (!res.ok) return 0;
  const data = (await res.json()) as { downloads?: number };
  return data.downloads ?? 0;
}

// -- Storage (file-based, keeps it simple) --

const DATA_DIR = ".8gent/growth";

async function ensureDir(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadSnapshots(): Promise<GrowthSnapshot[]> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(`${DATA_DIR}/snapshots.json`, "utf-8");
    return JSON.parse(raw) as GrowthSnapshot[];
  } catch {
    return [];
  }
}

async function saveSnapshots(snapshots: GrowthSnapshot[]): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await ensureDir();
  await writeFile(`${DATA_DIR}/snapshots.json`, JSON.stringify(snapshots, null, 2));
}

// -- Core logic --

export async function collectSnapshot(
  owner = "8gent",
  repo = "8gent-code",
  npmPkg = "8gent",
  websiteVisits = 0,
): Promise<GrowthSnapshot> {
  const [stars, downloads] = await Promise.all([
    fetchGitHubStars(owner, repo),
    fetchNpmWeeklyDownloads(npmPkg),
  ]);

  const snapshot: GrowthSnapshot = {
    date: new Date().toISOString().slice(0, 10),
    githubStars: stars,
    npmDownloadsWeekly: downloads,
    websiteVisits,
    source: "github",
  };

  const existing = await loadSnapshots();
  existing.push(snapshot);
  await saveSnapshots(existing);

  return snapshot;
}

function pct(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function generateWeeklyReport(): Promise<WeeklyReport> {
  const snapshots = await loadSnapshots();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const current = snapshots.filter((s) => new Date(s.date) >= weekAgo);
  const previous = snapshots.filter(
    (s) => new Date(s.date) < weekAgo && new Date(s.date) >= new Date(weekAgo.getTime() - 7 * 86_400_000),
  );

  const latest = current[current.length - 1] ?? { githubStars: 0, npmDownloadsWeekly: 0, websiteVisits: 0 };
  const prev = previous[previous.length - 1] ?? { githubStars: 0, npmDownloadsWeekly: 0, websiteVisits: 0 };

  const channels: ChannelMetrics[] = [
    {
      channel: "GitHub Stars",
      current: latest.githubStars,
      previous: prev.githubStars,
      delta: latest.githubStars - prev.githubStars,
      growthPct: pct(latest.githubStars, prev.githubStars),
    },
    {
      channel: "npm Downloads (weekly)",
      current: latest.npmDownloadsWeekly,
      previous: prev.npmDownloadsWeekly,
      delta: latest.npmDownloadsWeekly - prev.npmDownloadsWeekly,
      growthPct: pct(latest.npmDownloadsWeekly, prev.npmDownloadsWeekly),
    },
    {
      channel: "Website Visits",
      current: latest.websiteVisits,
      previous: prev.websiteVisits,
      delta: latest.websiteVisits - prev.websiteVisits,
      growthPct: pct(latest.websiteVisits, prev.websiteVisits),
    },
  ];

  const topChannel = [...channels].sort((a, b) => b.growthPct - a.growthPct)[0]?.channel ?? "none";

  const summary = channels
    .map((c) => `${c.channel}: ${c.current} (${c.delta >= 0 ? "+" : ""}${c.delta}, ${c.growthPct}%)`)
    .join(" | ");

  return {
    generatedAt: now.toISOString(),
    period: { from: weekAgo.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) },
    channels,
    topChannel,
    summary,
  };
}

// -- CLI entry --

if (import.meta.main) {
  const arg = process.argv[2];
  if (arg === "collect") {
    const snap = await collectSnapshot();
    console.log("Snapshot collected:", snap);
  } else {
    const report = await generateWeeklyReport();
    console.log("\n=== 8gent Weekly Growth Report ===");
    console.log(`Period: ${report.period.from} to ${report.period.to}`);
    console.log(`Top channel: ${report.topChannel}\n`);
    for (const c of report.channels) {
      const arrow = c.delta >= 0 ? "+" : "";
      console.log(`  ${c.channel}: ${c.current} (${arrow}${c.delta}, ${c.growthPct}%)`);
    }
    console.log(`\n${report.summary}`);
  }
}
