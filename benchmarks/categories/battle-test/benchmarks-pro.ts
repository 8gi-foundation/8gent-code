import type { BenchmarkDefinition } from "../../types";

/**
 * Battle Test Pro Benchmarks — Cross-Domain Professional Work
 *
 * BT011-BT015: Real-world professional tasks across video production,
 * music theory, data visualization, AI consulting, and security auditing.
 */

export const battleTestProBenchmarks: BenchmarkDefinition[] = [
	// ── BT011: Video Production Planner ($2K value) ─────────────────
	{
		id: "BT011",
		category: "battle-test",
		title: "Video Production Planner — Scene Graph, Timeline, FFmpeg Export",
		difficulty: "hard",
		prompt: `Build a video production planning system with timeline management and export tools.

## Requirements

### scene.ts
Scene and asset definitions:
- \`interface Asset\` — { type: "video" | "audio" | "image" | "text"; src: string; startTime: number; endTime: number }
- \`interface Effect\` — { type: "fade" | "dissolve" | "cut" | "zoom" | "pan"; duration: number; params?: Record<string, unknown> }
- \`class Scene\` — constructor(id: string, duration: number, type: "intro" | "main" | "transition" | "outro" | "b-roll")
  - \`.addAsset(asset: Asset): void\`
  - \`.removeAsset(src: string): void\`
  - \`.addEffect(effect: Effect): void\`
  - \`.getAssets(): Asset[]\`
  - \`.getEffects(): Effect[]\`
  - \`.id: string\` (readonly)
  - \`.duration: number\`
  - \`.type: string\` (readonly)

### timeline.ts
Timeline management:
- \`class Timeline\`
  - \`.addScene(scene: Scene): void\`
  - \`.removeScene(id: string): boolean\`
  - \`.reorderScenes(ids: string[]): void\` — reorder scenes to match the given ID array
  - \`.getTotalDuration(): number\` — sum of all scene durations
  - \`.getSceneAt(timeMs: number): Scene | null\` — which scene is playing at timeMs
  - \`.splitScene(id: string, atMs: number): [Scene, Scene]\` — split a scene at a time offset, returns two new scenes
  - \`.validate(): { valid: boolean; errors: string[] }\` — check for gaps and overlaps (scenes must be contiguous)
  - \`.toEDL(): string\` — returns Edit Decision List format string (one line per scene: index, reel, type, source-in, source-out, record-in, record-out)
  - \`.getScenes(): Scene[]\`

### exporter.ts
Export and reporting utilities:
- \`interface ExportConfig\` — { format: "mp4" | "webm" | "gif"; resolution: { w: number; h: number }; fps: number; codec?: string }
- \`function generateFFmpegCommand(timeline: Timeline, config: ExportConfig): string\` — returns a valid ffmpeg CLI command string
- \`function estimateFileSize(timeline: Timeline, config: ExportConfig): number\` — returns estimated file size in bytes (bitrate * duration formula)
- \`function generateShotList(timeline: Timeline): string\` — returns a markdown table with columns: #, Scene ID, Type, Duration, Assets, Effects

## Key Constraints
- Scene assets must validate startTime < endTime
- Timeline.getSceneAt must handle time=0 (first scene) and time beyond total (return null)
- EDL format: each line is "index  reel  type  HH:MM:SS:FF  HH:MM:SS:FF  HH:MM:SS:FF  HH:MM:SS:FF"
- FFmpeg command must include -i, resolution (-s WxH), fps (-r), format, codec if specified
- estimateFileSize: use bitrate = resolution.w * resolution.h * fps * 0.07 (bytes/sec), multiply by duration in seconds
- Export all classes, interfaces, and functions`,
		keywords: [
			"Scene",
			"Asset",
			"Effect",
			"Timeline",
			"addScene",
			"removeScene",
			"reorderScenes",
			"getTotalDuration",
			"getSceneAt",
			"splitScene",
			"validate",
			"toEDL",
			"ExportConfig",
			"generateFFmpegCommand",
			"estimateFileSize",
			"generateShotList",
			"duration",
			"transition",
			"fade",
			"dissolve",
			"cut",
			"ffmpeg",
			"resolution",
			"fps",
			"codec",
			"b-roll",
			"export",
		],
		keywordThreshold: 14,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT011-video.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT012: Music Theory Engine ($1.5K value) ────────────────────
	{
		id: "BT012",
		category: "battle-test",
		title: "Music Theory Engine — Notes, Chords, Scales, Progressions",
		difficulty: "hard",
		prompt: `Build a music theory engine with note manipulation, chord construction, and progression analysis.

## Requirements

### theory.ts
Core music theory primitives:
- \`type Note = "C" | "C#" | "D" | "D#" | "E" | "F" | "F#" | "G" | "G#" | "A" | "A#" | "B"\`
- \`type Interval = "unison" | "minor2" | "major2" | "minor3" | "major3" | "perfect4" | "tritone" | "perfect5" | "minor6" | "major6" | "minor7" | "major7" | "octave"\`
- \`const NOTES: Note[]\` — all 12 notes in chromatic order starting from C
- \`function noteToMidi(note: Note, octave: number): number\` — C4 = 60, formula: (octave + 1) * 12 + noteIndex
- \`function midiToNote(midi: number): { note: Note; octave: number }\`
- \`function transpose(note: Note, semitones: number): Note\` — wraps around (handles negative)
- \`function getInterval(note1: Note, note2: Note): Interval\` — returns the interval name between two notes
- \`const SCALE_PATTERNS: Record<string, number[]>\` — maps scale name to semitone intervals:
  - major: [2, 2, 1, 2, 2, 2, 1]
  - minor: [2, 1, 2, 2, 1, 2, 2]
  - dorian: [2, 1, 2, 2, 2, 1, 2]
  - mixolydian: [2, 2, 1, 2, 2, 1, 2]
  - pentatonic: [2, 2, 3, 2, 3]
  - blues: [3, 2, 1, 1, 3, 2]
- \`function getScale(root: Note, pattern: string): Note[]\` — returns the notes in the scale

### chord.ts
Chord construction and parsing:
- \`class Chord\`
  - Constructor: \`(root: Note, quality: "major" | "minor" | "diminished" | "augmented" | "dom7" | "maj7" | "min7")\`
  - \`.getNotes(): Note[]\` — returns the notes in the chord based on quality:
    - major: [0, 4, 7], minor: [0, 3, 7], diminished: [0, 3, 6], augmented: [0, 4, 8]
    - dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10]
  - \`.invert(n: number): Note[]\` — nth inversion (rotate first n notes up an octave — just moves them to end of array)
  - \`.toSymbol(): string\` — e.g., "C" for C major, "Am" for A minor, "Cmaj7", "Dm7", "Bdim", "Faug", "G7"
  - \`static fromSymbol(symbol: string): Chord\` — parse "Am7" → Chord(A, min7), "G" → Chord(G, major), "Bdim" → Chord(B, diminished), "F+" or "Faug" → Chord(F, augmented), "C7" → Chord(C, dom7)
  - \`.root: Note\` (readonly)
  - \`.quality: string\` (readonly)

### progression.ts
Chord progression analysis:
- \`class ChordProgression\`
  - Constructor: \`(key: Note, mode: "major" | "minor")\`
  - \`.addChord(chord: Chord): void\`
  - \`.getChords(): Chord[]\`
  - \`.analyze(): { romanNumerals: string[]; tensions: number[] }\`
    - Roman numerals: I, ii, iii, IV, V, vi, vii° for major key (uppercase = major, lowercase = minor)
    - Tensions: distance from diatonic expectation (0 = diatonic, 1+ = chromatic/borrowed)
  - \`.transpose(semitones: number): ChordProgression\` — returns new progression transposed
  - \`.suggest(length: number): Chord[][]\` — returns common progressions of the given length (e.g., length 4: I-V-vi-IV, I-IV-V-I, ii-V-I-I)
  - \`.toNashvilleNumbers(): string[]\` — returns ["1", "5", "6m", "4"] style numbering
  - \`.key: Note\` (readonly)
  - \`.mode: string\` (readonly)

## Key Constraints
- MIDI: C4 = 60, middle C convention
- Transpose must wrap: transpose("B", 1) → "C", transpose("C", -1) → "B"
- Chord.fromSymbol must handle: major (no suffix), minor ("m"), diminished ("dim"), augmented ("aug" or "+"), dom7 ("7"), maj7 ("maj7"), min7 ("m7")
- Nashville numbers: major chords = just number, minor = number + "m"
- Export all types, constants, classes, and functions`,
		keywords: [
			"Note",
			"Interval",
			"NOTES",
			"noteToMidi",
			"midiToNote",
			"transpose",
			"getInterval",
			"SCALE_PATTERNS",
			"getScale",
			"Chord",
			"getNotes",
			"invert",
			"toSymbol",
			"fromSymbol",
			"major",
			"minor",
			"diminished",
			"augmented",
			"dom7",
			"maj7",
			"min7",
			"ChordProgression",
			"analyze",
			"romanNumerals",
			"tensions",
			"toNashvilleNumbers",
			"suggest",
			"pentatonic",
			"blues",
			"MIDI",
			"export",
		],
		keywordThreshold: 15,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT012-music.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT013: Data Visualization Engine ($1.5K value) ──────────────
	{
		id: "BT013",
		category: "battle-test",
		title: "Data Visualization Engine — Charts, Scales, Layouts in SVG/ASCII",
		difficulty: "hard",
		prompt: `Build a data visualization engine that generates SVG and ASCII charts with proper scales and layouts.

## Requirements

### chart.ts
Chart generation:
- \`interface ChartConfig\` — { type: "bar" | "line" | "pie" | "scatter" | "heatmap"; data: Array<{ label: string; value: number }> | Array<{ x: number; y: number }> | number[]; options?: { title?: string; width?: number; height?: number; colors?: string[] } }
- \`function generateSVG(config: ChartConfig): string\` — returns valid SVG markup string.
  - **MUST always include both \`<svg\` (opening) and \`</svg>\` (closing) tags.**
  - **Bar chart MUST include at least one \`<rect\` element per data point.**
  - **Pie chart MUST include at least one \`<path\` element per slice.**
  - **If \`options.title\` is provided, output MUST include both \`<title>\` and the literal title text** (tests check both \`svg.includes("<title>")\` and \`svg.includes("My Chart")\`).
- \`function generateASCII(config: ChartConfig): string\` — returns ASCII chart string.
  - **MUST be a non-empty string and must include each data point's \`label\`** (tests assert ascii.includes("A") and ascii.includes("B") for labels A and B).
- \`function calculateBounds(data: number[]): { min: number; max: number; range: number; mean: number; median: number; stdDev: number }\`
  - \`range\` = max - min. \`mean\` = sum/n. \`median\` = middle element of sorted array (odd-length).
  - \`stdDev\` = population standard deviation, must be > 0 for any non-constant input.

### scale.ts
Scale functions for mapping data to visual coordinates:
- \`function linearScale(domain: [number, number], range: [number, number]): (value: number) => number\`
  - Maps value from domain to range linearly
- \`function logScale(domain: [number, number], range: [number, number]): (value: number) => number\`
  - Maps value using log10 scale
- \`function bandScale(domain: string[], range: [number, number]): (value: string) => number\`
  - Maps categorical values to evenly-spaced positions
- \`function colorScale(domain: [number, number], colors: string[]): (value: number) => string\`
  - Interpolates between colors based on value position in domain
  - Colors are hex strings like "#ff0000"
- \`function niceNumbers(min: number, max: number, tickCount: number): number[]\`
  - Returns "nice" axis tick values (rounded to clean numbers)
  - e.g., niceNumbers(0.5, 9.8, 5) might return [0, 2, 4, 6, 8, 10]

### layout.ts
Layout calculations for positioning chart elements:
- \`function calculateBarLayout(data: { label: string; value: number }[], width: number, height: number, padding?: number): { x: number; y: number; width: number; height: number; label: string; value: number }[]\`
  - Returns positioned rectangles for a vertical bar chart
- \`function calculatePieLayout(data: { label: string; value: number }[]): { label: string; value: number; percentage: number; startAngle: number; endAngle: number }[]\`
  - Angles in radians, full circle = 2π, starts at 0 (top/right)
- \`function calculateGridLayout(items: number, width: number, height: number): { cols: number; rows: number; cellWidth: number; cellHeight: number }\`
  - Calculates optimal grid arrangement (as square as possible)
- \`function calculateAxisTicks(min: number, max: number, count: number): { value: number; position: number }[]\`
  - Returns tick values and their normalized position (0-1)

## Key Constraints
- SVG output must be valid XML (proper closing tags, quoted attributes)
- linearScale(domain, range)(domain[0]) must equal range[0] exactly
- bandScale must distribute items evenly across the range
- Pie layout angles must sum to exactly 2π (within floating point tolerance)
- calculateBounds stdDev must use population standard deviation
- niceNumbers must return values that extend beyond min/max
- Export all interfaces, functions`,
		keywords: [
			"ChartConfig",
			"generateSVG",
			"generateASCII",
			"calculateBounds",
			"svg",
			"rect",
			"path",
			"polyline",
			"title",
			"linearScale",
			"logScale",
			"bandScale",
			"colorScale",
			"niceNumbers",
			"domain",
			"range",
			"tick",
			"calculateBarLayout",
			"calculatePieLayout",
			"calculateGridLayout",
			"calculateAxisTicks",
			"startAngle",
			"endAngle",
			"percentage",
			"min",
			"max",
			"mean",
			"median",
			"stdDev",
			"export",
		],
		keywordThreshold: 14,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT013-dataviz.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT014: AI Consultancy Report Generator ($2.5K value) ────────
	{
		id: "BT014",
		category: "battle-test",
		title: "AI Consultancy Report Generator — Assessment, Recommendations, Roadmap",
		difficulty: "hard",
		prompt: `Build an AI consultancy report generation system that assesses company readiness, generates recommendations, and creates project roadmaps.

## Requirements

### assessment.ts
Company AI readiness assessment:
- \`interface CompanyProfile\` — { name: string; size: "startup" | "smb" | "enterprise"; industry: string; currentTools: string[]; dataMaturity: 1 | 2 | 3 | 4 | 5; budget: number; painPoints: string[] }
- \`interface ReadinessReport\` — { score: number (0-100); tier: "beginner" | "intermediate" | "advanced"; strengths: string[]; gaps: string[]; risks: string[] }
- \`interface ComparisonResult\` — { percentile: number; aboveAverage: string[]; belowAverage: string[]; industryAvgScore: number }
- \`function assessAIReadiness(company: CompanyProfile): ReadinessReport\`
  - Score formula: dataMaturity * 15 + (currentTools.length * 5, max 20) + (budget >= 100000 ? 15 : budget >= 50000 ? 10 : 5) + (size === "enterprise" ? 10 : size === "smb" ? 5 : 0) + min(painPoints.length * 3, 15)
  - Tier: 0-40 beginner, 41-70 intermediate, 71-100 advanced
  - Strengths: items where score component is above threshold
  - Gaps: areas below threshold (e.g., low dataMaturity, few tools)
  - Risks: based on tier and gaps (e.g., "Insufficient data infrastructure" if dataMaturity < 3)
- \`function benchmarkAgainstIndustry(profile: CompanyProfile, industryData: CompanyProfile[]): ComparisonResult\`
  - Compares the company's readiness score against all profiles in industryData
  - percentile: what percent of industry scores are below this company's score

### recommendation.ts
AI strategy recommendations:
- \`interface Recommendation\` — { title: string; description: string; impact: "high" | "medium" | "low"; effort: "high" | "medium" | "low"; estimatedROI: number; timelineWeeks: number; dependencies: string[] }
- \`function generateRecommendations(report: ReadinessReport, budget: number): Recommendation[]\`
  - Beginner tier: data infrastructure, team training, pilot project
  - Intermediate tier: ML pipeline, automation expansion, advanced analytics
  - Advanced tier: custom models, AI-first processes, real-time systems
  - Filter by budget (exclude recommendations where implied cost > budget)
- \`function prioritize(recommendations: Recommendation[], criteria: "roi" | "speed" | "impact"): Recommendation[]\`
  - roi: sort by estimatedROI descending
  - speed: sort by timelineWeeks ascending
  - impact: sort by impact (high > medium > low), then effort (low > medium > high)
- \`function estimateTotalCost(recommendations: Recommendation[]): { cost: number; timeline: number; expectedROI: number }\`
  - cost: sum of (timelineWeeks * 2500) for each recommendation
  - timeline: max timelineWeeks (parallel execution) + 2 weeks buffer per dependency chain
  - expectedROI: sum of estimatedROI

### roadmap.ts
Project roadmap generation:
- \`interface Milestone\` — { name: string; date: string; deliverables: string[]; criteria: string[] }
- \`interface Phase\` — { name: string; startDate: string; endDate: string; milestones: Milestone[]; recommendations: Recommendation[] }
- \`function generateRoadmap(recommendations: Recommendation[], startDate: string): Phase[]\`
  - Groups recommendations into phases: "Foundation" (first), "Implementation" (middle), "Optimization" (last)
  - Each phase gets at least one milestone
  - Dates calculated from startDate + cumulative weeks (ISO format YYYY-MM-DD)
- \`function toGanttData(phases: Phase[]): { tasks: { name: string; start: string; end: string; phase: string }[] }\`
  - Flattens phases into a task list for Gantt chart rendering
- \`function toMarkdown(phases: Phase[]): string\`
  - Formatted roadmap with headers, bullet points, dates
  - Must include phase names, date ranges, milestones, and deliverables

## Key Constraints
- Assessment score must be deterministic (same input → same output)
- Recommendations must be filtered by budget constraint
- Roadmap dates must be valid ISO dates and sequential
- toMarkdown must include "##" headers for each phase
- benchmarkAgainstIndustry must handle empty industryData (return 0 percentile)
- Export all interfaces and functions`,
		keywords: [
			"CompanyProfile",
			"ReadinessReport",
			"assessAIReadiness",
			"benchmarkAgainstIndustry",
			"ComparisonResult",
			"percentile",
			"score",
			"tier",
			"beginner",
			"intermediate",
			"advanced",
			"strengths",
			"gaps",
			"risks",
			"dataMaturity",
			"Recommendation",
			"generateRecommendations",
			"prioritize",
			"estimateTotalCost",
			"ROI",
			"impact",
			"effort",
			"timeline",
			"Phase",
			"Milestone",
			"generateRoadmap",
			"toGanttData",
			"toMarkdown",
			"deliverables",
			"criteria",
			"export",
		],
		keywordThreshold: 15,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT014-ai-consulting.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},

	// ── BT015: Security Audit Framework ($2K value) ─────────────────
	{
		id: "BT015",
		category: "battle-test",
		title: "Security Audit Framework — Scanner, Vulnerability DB, Report Generator",
		difficulty: "hard",
		prompt: `Build a security audit framework that scans code, dependencies, and configurations for vulnerabilities.

## Requirements

### scanner.ts
Security scanning tools:
- \`interface DepScanResult\` — { vulnerabilities: Vulnerability[]; scannedCount: number; riskyPackages: string[] }
- \`interface CodeScanResult\` — { vulnerabilities: Vulnerability[]; linesScanned: number; patterns: { pattern: string; line: number; severity: string }[] }
- \`interface ConfigScanResult\` — { vulnerabilities: Vulnerability[]; checksPerformed: number; issues: string[] }
- \`function scanDependencies(packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): DepScanResult\`
  - **\`riskyPackages\` is an array of package NAMES (the keys), not version strings.** So for \`{ dependencies: { "some-lib": "*" } }\` → \`riskyPackages: ["some-lib"]\`.
  - Flag versions equal to \`"*"\` or \`"latest"\` as medium severity and add the package name to \`riskyPackages\`.
  - **\`scannedCount\` = total deps + devDeps (counts both maps combined).**
  - **For safe semver versions like "^18.2.0" or "^5.0.0", \`riskyPackages\` MUST be empty.**
- \`function scanCode(code: string): CodeScanResult\`
  - Detect \`eval(\` → push a Vulnerability with \`severity: "critical"\` AND \`category: "injection"\`. Tests look up by \`v.category === "injection"\` and assert severity is "critical".
  - Detect \`innerHTML\` → push a Vulnerability with \`category: "xss"\`.
  - Detect hardcoded secrets like \`password = "..."\`, \`apiKey = "..."\`, \`token = "..."\`, \`secret = "..."\` — push at least one Vulnerability per occurrence.
  - **Each detected pattern MUST also be appended to \`patterns\` with a 1-indexed \`line\` number** (so \`eval\` on line 2 → \`{ pattern: "eval", line: 2, severity: "critical" }\`).
  - Safe code (no patterns) → \`vulnerabilities: []\` and \`patterns: []\`.
- \`function scanConfig(config: Record<string, unknown>): ConfigScanResult\`
  - \`debug: true\` → push Vulnerability with title or description containing the word "debug".
  - \`cors: "*"\` or \`cors.origin: "*"\` → push Vulnerability with \`severity: "high"\`.
  - \`crypto.algorithm\` equal to \`"md5"\` or \`"sha1"\` → push at least one Vulnerability.
  - **Safe config (e.g., \`{ port: 443, tls: true }\`) → \`vulnerabilities: []\`.**

### vulnerability.ts
Vulnerability management:
- \`interface Vulnerability\` — { id: string; title: string; severity: "critical" | "high" | "medium" | "low" | "info"; category: "injection" | "auth" | "xss" | "config" | "dependency"; description: string; remediation: string; cvss?: number }
- \`function calculateRiskScore(vulns: Vulnerability[]): number\`
  - Weighted sum: critical=10, high=7, medium=4, low=1, info=0
  - Normalize to 0-100 scale: min(sum, 100)
- \`function groupBySeverity(vulns: Vulnerability[]): Record<string, Vulnerability[]>\`
  - Groups into { critical: [...], high: [...], medium: [...], low: [...], info: [...] }
- \`function getRemediationPriority(vulns: Vulnerability[]): Vulnerability[]\`
  - Sort by: severity (critical first), then by cvss score descending (if available), then by category priority (injection > auth > xss > config > dependency)

### report.ts
Security report generation:
- \`interface SecurityReport\` — { grade: "A" | "B" | "C" | "D" | "F"; score: number; findings: Vulnerability[]; summary: string; generatedAt: string }
- \`function generateSecurityReport(scanResults: { deps?: DepScanResult; code?: CodeScanResult; config?: ConfigScanResult }): SecurityReport\`
  - Combines all vulnerabilities from all scan results
  - Grade: A (0-10 risk score), B (11-25), C (26-50), D (51-75), F (76-100)
  - Summary: "Found X vulnerabilities (Y critical, Z high). Grade: G. Top risk: ..."
  - generatedAt: ISO date string
- \`function toMarkdown(report: SecurityReport): string\`
  - Formatted security report with:
    - "# Security Audit Report" header
    - Grade and score
    - Executive summary
    - Findings grouped by severity
    - Remediation steps
- \`function toJSON(report: SecurityReport): string\`
  - JSON.stringify with 2-space indentation

## Key Constraints
- Scanner regex patterns must not false-positive on comments about eval (but ok to be simple)
- Risk score must be capped at 100
- Grade boundaries must be consistent with score
- Report must include ALL vulnerabilities from ALL scan types
- Remediation priority: critical injection is always #1
- toMarkdown must include "# Security Audit Report" header
- Export all interfaces and functions`,
		keywords: [
			"scanDependencies",
			"scanCode",
			"scanConfig",
			"DepScanResult",
			"CodeScanResult",
			"ConfigScanResult",
			"Vulnerability",
			"severity",
			"critical",
			"high",
			"medium",
			"low",
			"category",
			"injection",
			"auth",
			"xss",
			"config",
			"dependency",
			"calculateRiskScore",
			"groupBySeverity",
			"getRemediationPriority",
			"cvss",
			"remediation",
			"SecurityReport",
			"generateSecurityReport",
			"grade",
			"score",
			"toMarkdown",
			"toJSON",
			"findings",
			"summary",
			"eval",
			"innerHTML",
			"CORS",
			"CSP",
			"export",
		],
		keywordThreshold: 16,
		testExecution: true,
		testFile: "categories/battle-test/tests/BT015-security.test.ts",
		multiFile: true,
		timeoutMs: 15000,
	},
];
