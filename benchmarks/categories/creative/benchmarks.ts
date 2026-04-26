/**
 * 8gent Code Benchmarks - Creative Skills
 *
 * Tests non-coding abilities: music, songwriting, creative writing
 * Uses APIs like Suno, Udio, or generates code for music tools
 */

import type { BenchmarkDefinition } from "../../types";

export const creativeBenchmarks: BenchmarkDefinition[] = [
	{
		id: "CR001",
		name: "Write Song Lyrics",
		category: "creative",
		difficulty: "medium",
		description: "Generate original song lyrics with proper structure",
		task: `Write original song lyrics that:
1. Has verse-chorus-verse-chorus-bridge-chorus structure
2. Theme: overcoming challenges
3. Rhyme scheme: ABAB for verses, AABB for chorus
4. Includes emotional progression
5. 2-3 minutes when sung at normal tempo`,
		expectedBehavior: "Lyrics follow structure, rhymes work, theme is clear, emotionally engaging",
		fixture: "fixtures/creative/CR001-lyrics-prompt.txt",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Follows specified structure",
					"Rhyme scheme is correct",
					"Theme is present throughout",
					"Appropriate length",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: [
					"Consistent syllable counts per line",
					"Natural word choices",
					"Memorable hook/chorus",
				],
			},
			efficiency: {
				weight: 20,
				criteria: ["No filler words", "Every line serves the theme", "Tight, economical lyrics"],
			},
			bestPractices: {
				weight: 15,
				criteria: ["Original (not derivative)", "Singable phrasing", "Emotional authenticity"],
			},
		},
		validators: [{ type: "llm", config: { rubric: "song_lyrics", model: "gpt-4" } }],
		expectedTokens: 500,
		timeLimit: 120,
	},
	{
		id: "CR002",
		name: "Generate Music with Tone.js",
		category: "creative",
		difficulty: "hard",
		description: "Create a procedural music generator using Tone.js",
		task: `Create a web-based music generator that:
1. Uses Tone.js for audio synthesis
2. Generates a 4-chord progression (e.g., I-V-vi-IV)
3. Creates a simple melody over the chords
4. Has start/stop controls
5. Allows tempo adjustment
6. Sounds musical (not random noise)`,
		expectedBehavior: "Music plays, sounds harmonious, controls work, tempo adjusts",
		fixture: "fixtures/creative/CR002-tonejs-template.ts",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Audio plays without errors",
					"Chord progression is correct",
					"Melody follows chord tones",
					"Controls function",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: [
					"Clean Tone.js usage",
					"Proper Transport scheduling",
					"TypeScript types for notes",
				],
			},
			efficiency: {
				weight: 20,
				criteria: ["Efficient scheduling", "No audio glitches", "Proper resource cleanup"],
			},
			bestPractices: {
				weight: 15,
				criteria: [
					"Uses Tone.Transport",
					"Handles audio context state",
					"User-triggered audio start",
				],
			},
		},
		validators: [
			{
				type: "ast",
				config: {
					mustContain: ["Tone.Synth", "Tone.Transport", "triggerAttackRelease"],
				},
			},
			{ type: "execution", config: { timeout: 10000, expectNoErrors: true } },
		],
		expectedTokens: 1200,
		timeLimit: 240,
	},
	{
		id: "CR003",
		name: "Create Visual Art with p5.js",
		category: "creative",
		difficulty: "medium",
		description: "Generate algorithmic art using p5.js",
		task: `Create a p5.js sketch that:
1. Generates a unique artwork each time
2. Uses Perlin noise for organic shapes
3. Has a cohesive color palette
4. Includes animation/movement
5. Can be saved as PNG
6. Uses seed for reproducibility`,
		expectedBehavior: "Art generates, looks visually appealing, animates, saves correctly",
		fixture: "fixtures/creative/CR003-p5-template.ts",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Sketch runs without errors",
					"Uses Perlin noise",
					"Color palette is cohesive",
					"Save functionality works",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: [
					"Clean p5.js structure",
					"Proper setup/draw separation",
					"Commented creative choices",
				],
			},
			efficiency: {
				weight: 20,
				criteria: ["Maintains 60fps", "Efficient noise calculations", "No memory leaks"],
			},
			bestPractices: {
				weight: 15,
				criteria: [
					"Uses createCanvas properly",
					"Implements instance mode",
					"Handles resize gracefully",
				],
			},
		},
		validators: [
			{
				type: "ast",
				config: { mustContain: ["noise", "setup", "draw", "createCanvas"] },
			},
		],
		expectedTokens: 1000,
		timeLimit: 180,
	},
	{
		id: "CR004",
		name: "Write Technical Blog Post",
		category: "creative",
		difficulty: "medium",
		description: "Write a technical blog post explaining a concept",
		task: `Write a blog post about "Understanding React Server Components" that:
1. Has engaging introduction
2. Explains the concept clearly for intermediate devs
3. Includes code examples
4. Uses analogies for complex concepts
5. Has practical "when to use" section
6. 800-1200 words`,
		expectedBehavior: "Post is clear, accurate, engaging, and actionable",
		fixture: "fixtures/creative/CR004-blog-prompt.txt",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Technical accuracy",
					"Code examples work",
					"Covers key concepts",
					"Appropriate length",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: ["Clear structure", "Good headings", "Proper code formatting"],
			},
			efficiency: {
				weight: 20,
				criteria: ["No redundant explanations", "Concise writing", "Efficient word choice"],
			},
			bestPractices: {
				weight: 15,
				criteria: ["SEO-friendly title", "Includes TL;DR", "Has call-to-action"],
			},
		},
		validators: [{ type: "llm", config: { rubric: "technical_writing", model: "gpt-4" } }],
		expectedTokens: 1500,
		timeLimit: 300,
	},
];

export default creativeBenchmarks;
