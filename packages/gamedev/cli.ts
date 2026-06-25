#!/usr/bin/env bun
/**
 * 8gent Gamedev CLI
 *
 * Local-first 2D game dev pipeline:
 *   gamedev slice <sheet.png> --cols 8 --rows 4 --output ./frames
 *   gamedev animate ./frames --fps 12 --output ./walk.gif
 *   gamedev pack ./frames --cols 8 --output ./sheet.png
 *   gamedev prompt character --style pixel-art --cols 8
 *   gamedev scaffold my-game --engine phaser --type platformer
 */

import { sliceSpriteSheet } from "./sprite-slicer";
import { animate, packSpriteSheet } from "./animation-generator";
import { buildSpritePrompt, SPRITE_PROMPTS } from "./prompts";
import { scaffoldGame } from "./scaffold";
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
	console.log(`
8gent Gamedev CLI — local-first 2D game dev pipeline

Usage:
  gamedev slice <sheet.png> [options]    Slice a sprite sheet into frames
  gamedev animate <frames/> [options]     Generate animated output from frames
  gamedev pack <frames/> [options]        Pack frames into a sprite sheet
  gamedev prompt <type> [options]          Build an AI sprite generation prompt
  gamedev scaffold <name> [options]       Scaffold a new game project

Examples:
  gamedev slice sprites.png --cols 8 --rows 4 -o ./frames
  gamedev animate ./frames --fps 12 -o walk.webp
  gamedev pack ./frames --cols 8 -o sheet.png
  gamedev prompt character --style pixel-art --subject knight
  gamedev scaffold "My Game" --engine phaser --type platformer
`);
	process.exit(0);
}

// ── Parse common flags ──────────────────────────────────────────

function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = args[i + 1];
			if (next && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			flags[arg[1]] = true;
		} else {
			positional.push(arg);
		}
	}

	return { flags, positional };
}

// ── Commands ────────────────────────────────────────────────────

async function cmdSlice(positional: string[], flags: Record<string, string | boolean>) {
	const [input] = positional;
	if (!input) {
		console.error("Usage: gamedev slice <sprite-sheet.png> [--cols N] [--rows N] [-o dir]");
		process.exit(1);
	}

	const outputDir = (flags.o || flags.output || "./frames") as string;
	const cols = flags.cols ? parseInt(flags.cols as string) : undefined;
	const rows = flags.rows ? parseInt(flags.rows as string) : undefined;

	console.log(`Slicing ${input} -> ${outputDir}`);
	const result = await sliceSpriteSheet({ input, outputDir, cols, rows, atlas: true });
	console.log(`\nDone. ${result.totalFrames} frames extracted.`);
	console.log(`Atlas: ${result.atlasPath}`);
}

async function cmdAnimate(positional: string[], flags: Record<string, string | boolean>) {
	const [framesDir] = positional;
	if (!framesDir) {
		console.error("Usage: gamedev animate <frames-dir> [--fps N] [-o output.gif]");
		process.exit(1);
	}

	const output = (flags.o || flags.output || "./output.webp") as string;
	const fps = flags.fps ? parseInt(flags.fps as string) : 12;

	console.log(`Animating frames from ${framesDir} at ${fps} fps -> ${output}`);
	const result = await animate({ frames: framesDir, output, fps });

	console.log(`\nDone.`);
	console.log(`  Output:  ${result.outputPath}`);
	console.log(`  Format:  ${result.format}`);
	console.log(`  Frames:  ${result.frameCount}`);
	console.log(`  Size:    ${result.width}x${result.height}`);
	console.log(`  Duration: ${result.totalDuration}s`);
}

async function cmdPack(positional: string[], flags: Record<string, string | boolean>) {
	const [framesDir] = positional;
	if (!framesDir) {
		console.error("Usage: gamedev pack <frames-dir> [--cols N] [-o output.png]");
		process.exit(1);
	}

	const output = (flags.o || flags.output || "./sheet.png") as string;
	const cols = flags.cols ? parseInt(flags.cols as string) : 8;

	console.log(`Packing frames from ${framesDir} -> ${output}`);
	const result = await packSpriteSheet({ frames: framesDir, output, cols });

	console.log(`\nDone.`);
	console.log(`  Output:   ${result.outputPath}`);
	console.log(`  Grid:     ${result.cols}x${result.rows}`);
	console.log(`  Frames:   ${result.totalFrames}`);
	console.log(`  Sheet:    ${result.width}x${result.height}`);
	console.log(`  Frame:    ${result.frameWidth}x${result.frameHeight}`);
}

function cmdPrompt(positional: string[], flags: Record<string, string | boolean>) {
	const [type] = positional;
	if (!type) {
		console.log("\nAvailable prompt types:");
		console.log("  character  — walk cycle, idle, attack sprites");
		console.log("  tileset    — terrain, walls, objects");
		console.log("  ui         — buttons, frames, icons");
		console.log("  items      — weapons, potions, loot");
		console.log("  particles  — explosions, sparks, effects");
		console.log("\nUsage: gamedev prompt <type> [--subject X] [--style pixel-art] [--cols N]");
		console.log("\nExample:");
		console.log("  gamedev prompt character --subject warrior --style pixel-art --cols 8");
		process.exit(0);
	}

	const subject = (flags.subject || "game asset") as string;
	const style = (flags.style || "pixel-art") as string;

	// Build config from flags
	const config: Record<string, any> = { subject, style };
	if (flags.cols) config.cols = parseInt(flags.cols as string);
	if (flags.rows) config.rows = parseInt(flags.rows as string);
	if (flags.frameSize) config.frameSize = parseInt(flags.frameSize as string);
	if (flags.view) config.view = flags.view;
	if (flags.background) config.background = flags.background;
	if (flags.animation) config.animation = flags.animation;

	const prompt = buildSpritePrompt(config as any);
	console.log("\n" + prompt + "\n");

	// Also output ChatGPT image API format example
	const w = (config.cols || 8) * (config.frameSize || 64);
	const h = (config.rows || 4) * (config.frameSize || 64);
	console.log("ChatGPT Image API example:");
	console.log(`  Generate at exactly ${w}x${h} pixels for a clean ${config.cols || 8}x${config.rows || 4} grid.`);
}

async function cmdScaffold(positional: string[], flags: Record<string, string | boolean>) {
	const [name] = positional;
	if (!name) {
		console.error("Usage: gamedev scaffold <game-name> [--engine phaser|pixi] [--type platformer|topdown|shooter|puzzle]");
		process.exit(1);
	}

	const outputDir = (flags.o || flags.output || `./${name.toLowerCase().replace(/\s+/g, "-")}`) as string;
	const engine = (flags.engine || "phaser") as "phaser" | "pixi";
	const type = (flags.type || "platformer") as "platformer" | "topdown" | "shooter" | "puzzle";

	console.log(`Scaffolding "${name}" (${engine}, ${type}) -> ${outputDir}`);
	const result = scaffoldGame({ name, outputDir, engine, type });

	console.log(`\nDone. ${result.files.length} files generated.`);
	console.log(`  Entry:  ${result.entryPoint}`);
	console.log(`\nTo run:`);
	console.log(`  cd ${outputDir} && bun install && bun run dev`);
}

// ── Router ───────────────────────────────────────────────────────

const { flags, positional } = parseFlags(args.slice(1));

switch (command) {
	case "slice":
		await cmdSlice(positional, flags);
		break;
	case "animate":
		await cmdAnimate(positional, flags);
		break;
	case "pack":
		await cmdPack(positional, flags);
		break;
	case "prompt":
		cmdPrompt(positional, flags);
		break;
	case "scaffold":
		await cmdScaffold(positional, flags);
		break;
	default:
		console.error(`Unknown command: ${command}`);
		console.error("Run 'gamedev' without args for usage.");
		process.exit(1);
}
