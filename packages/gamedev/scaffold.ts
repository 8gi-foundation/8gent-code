/**
 * Game Scaffolding Templates
 *
 * Generate starter game projects with Phaser 3 or Pixi.js.
 * Outputs a minimal but playable game structure.
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ───────────────────────────────────────────────────────

export interface GameConfig {
	/** Game title */
	name: string;
	/** Output directory */
	outputDir: string;
	/** Game engine */
	engine: "phaser" | "pixi";
	/** Game type */
	type: "platformer" | "topdown" | "shooter" | "puzzle";
	/** Canvas width */
	width?: number;
	/** Canvas height */
	height?: number;
	/** Path to sprite assets directory */
	assetsDir?: string;
}

// ── Scaffolder ──────────────────────────────────────────────────

/**
 * Generate a starter game project.
 */
export function scaffoldGame(config: GameConfig): {
	files: string[];
	entryPoint: string;
} {
	const { name, outputDir, engine, type, width = 800, height = 600 } = config;

	fs.mkdirSync(outputDir, { recursive: true });
	fs.mkdirSync(path.join(outputDir, "assets"), { recursive: true });

	const files: string[] = [];

	// package.json
	const pkg = {
		name: name.toLowerCase().replace(/\s+/g, "-"),
		version: "0.1.0",
		private: true,
		scripts: {
			dev: "bun run --hot src/main.ts",
			build: "bun build src/main.ts --outdir=dist",
		},
		dependencies:
			engine === "phaser" ? { phaser: "^3.80.0" } : { pixi: "^8.0.0" },
	};
	const pkgPath = path.join(outputDir, "package.json");
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
	files.push(pkgPath);

	// index.html
	const htmlPath = path.join(outputDir, "index.html");
	fs.writeFileSync(
		htmlPath,
		`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #111; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    canvas { image-rendering: pixelated; }
  </style>
</head>
<body>
  <script type="module" src="src/main.ts"></script>
</body>
</html>`,
	);
	files.push(htmlPath);

	// Main game file
	fs.mkdirSync(path.join(outputDir, "src"), { recursive: true });
	const mainPath = path.join(outputDir, "src", "main.ts");

	if (engine === "phaser") {
		fs.writeFileSync(mainPath, generatePhaserMain(name, type, width, height));
	} else {
		fs.writeFileSync(mainPath, generatePixiMain(name, type, width, height));
	}
	files.push(mainPath);

	return { files, entryPoint: htmlPath };
}

// ── Phaser Template ─────────────────────────────────────────────

function generatePhaserMain(
	name: string,
	type: string,
	w: number,
	h: number,
): string {
	const physics =
		type === "platformer" || type === "shooter" ? "arcade" : "none";

	return `import Phaser from "phaser";

class GameScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  constructor() {
    super("game");
  }

  preload() {
    // Load your sliced sprites here
    // this.load.spritesheet("player", "assets/player.png", { frameWidth: 64, frameHeight: 64 });

    // Placeholder: colored rectangle
    this.load.image("placeholder", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABHSURBVFhH7c4xAQAACAMgtf/pEGBhwUfAACAA8AICAICAAAAgAAAIAAACAIAAACAAAF6ys55n7Tf+vAAAAIAAACAAAPgfQZ0H7sUJF+IAAAAASUVORK5CYII=");
  }

  create() {
    // Create player
    this.player = this.physics.add.sprite(${w / 2}, ${h / 2}, "placeholder");
    ${type === "platformer" ? "this.player.setBounce(0.2);\n    this.player.setCollideWorldBounds(true);\n    this.physics.world.gravity.y = 800;" : "this.player.setCollideWorldBounds(true);"}

    // Input
    this.cursors = this.input.keyboard!.createCursorKeys();

    // Title text
    this.add.text(16, 16, "${name}", { fontSize: "24px", color: "#fff" });
  }

  update() {
    const speed = 200;
    this.player.setVelocityX(0);
    ${type !== "platformer" ? "this.player.setVelocityY(0);" : ""}

    if (this.cursors.left.isDown) this.player.setVelocityX(-speed);
    if (this.cursors.right.isDown) this.player.setVelocityX(speed);
    ${
			type === "platformer"
				? "if (this.cursors.up.isDown && this.player.body!.touching.down) this.player.setVelocityY(-500);"
				: "if (this.cursors.up.isDown) this.player.setVelocityY(-speed);\n    if (this.cursors.down.isDown) this.player.setVelocityY(speed);"
		}
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: ${w},
  height: ${h},
  ${physics !== "none" ? `physics: { default: "arcade", arcade: { gravity: { x: 0, y: ${type === "platformer" ? 800 : 0} }, debug: false } },` : ""}
  scene: GameScene,
  pixelArt: true,
  backgroundColor: "#1a1a2e",
};

new Phaser.Game(config);
`;
}

// ── Pixi Template ───────────────────────────────────────────────

function generatePixiMain(
	name: string,
	_type: string,
	w: number,
	h: number,
): string {
	return `import { Application, Graphics, Text } from "pixi.js";

const app = new Application();

async function init() {
  await app.init({
    width: ${w},
    height: ${h},
    backgroundColor: 0x1a1a2e,
  });

  document.body.appendChild(app.canvas);

  // Player (placeholder rectangle)
  const player = new Graphics();
  player.rect(0, 0, 32, 32).fill(0x4ecdc4);
  player.x = ${w / 2} - 16;
  player.y = ${h / 2} - 16;
  app.stage.addChild(player);

  // Title
  const title = new Text({ text: "${name}", style: { fill: "#ffffff", fontSize: 24 } });
  title.x = 16;
  title.y = 16;
  app.stage.addChild(title);

  // Input
  const keys: Record<string, boolean> = {};
  window.addEventListener("keydown", (e) => { keys[e.key] = true; });
  window.addEventListener("keyup", (e) => { keys[e.key] = false; });

  // Game loop
  const speed = 3;
  app.ticker.add(() => {
    if (keys["ArrowLeft"]) player.x -= speed;
    if (keys["ArrowRight"]) player.x += speed;
    if (keys["ArrowUp"]) player.y -= speed;
    if (keys["ArrowDown"]) player.y += speed;

    // Bounds
    player.x = Math.max(0, Math.min(${w} - 32, player.x));
    player.y = Math.max(0, Math.min(${h} - 32, player.y));
  });
}

init();
`;
}
