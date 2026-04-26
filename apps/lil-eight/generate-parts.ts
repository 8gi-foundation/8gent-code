/**
 * AI Art Generator for Companion Species
 *
 * Generates layered body part PNGs using Fal.ai Flux model.
 * Each species gets unique BODY and HEAD art at 512x512,
 * which gets composited and downscaled to 64x64 by generate-sprites.ts.
 *
 * Usage:
 *   bun run apps/lil-eight/generate-parts.ts --species Drake
 *   bun run apps/lil-eight/generate-parts.ts --species all
 *
 * Requires FAL_KEY env var (from ~/Myresumeportfolio/.env.local)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Load API keys from env or from Myresumeportfolio .env.local
let FAL_KEY = process.env.FAL_KEY;
let OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

try {
	const envFile = readFileSync(
		join(process.env.HOME || "~", "Myresumeportfolio/.env.local"),
		"utf-8",
	);
	if (!FAL_KEY) {
		const m = envFile.match(/FAL_KEY=(.+)/);
		if (m) FAL_KEY = m[1].trim();
	}
	if (!OPENAI_API_KEY) {
		const m = envFile.match(/OPENAI_API_KEY=(.+)/);
		if (m) OPENAI_API_KEY = m[1].trim();
	}
	if (!REPLICATE_API_KEY) {
		const m = envFile.match(/REPLICATE_API_KEY=(.+)/);
		if (m) REPLICATE_API_KEY = m[1].trim();
	}
} catch {}

// Provider selection: try Fal first, fall back to DALL-E, then Replicate
type Provider = "fal" | "dalle" | "replicate";
let provider: Provider = "fal";
if (!FAL_KEY && OPENAI_API_KEY) provider = "dalle";
else if (!FAL_KEY && !OPENAI_API_KEY && REPLICATE_API_KEY)
	provider = "replicate";
else if (!FAL_KEY && !OPENAI_API_KEY && !REPLICATE_API_KEY) {
	console.error(
		"No image gen API key found (FAL_KEY, OPENAI_API_KEY, or REPLICATE_API_KEY)",
	);
	process.exit(1);
}

// Allow manual override
const providerArg = process.argv
	.find((a) => a.startsWith("--provider="))
	?.split("=")[1] as Provider | undefined;
if (providerArg) provider = providerArg;

console.log(`Using provider: ${provider}`);

// Species descriptions for prompt generation
// Grouped by body type archetype for visual consistency
const SPECIES_PROMPTS: Record<string, { body: string; head: string }> = {
	// Common - small creatures
	Imp: {
		body: "tiny devil creature with small wings and a pointed tail, standing upright",
		head: "small horned head with mischievous grin, pointy ears",
	},
	Goblin: {
		body: "short hunched goblin creature with long arms, standing",
		head: "large-eared goblin head with sharp teeth and beady eyes",
	},
	Sprite: {
		body: "small glowing fairy creature with translucent wings",
		head: "ethereal fairy face with large luminous eyes",
	},
	Slime: {
		body: "round blob creature with small stubby arms, gelatinous body",
		head: "blobby dome head with two dot eyes, no neck",
	},
	Familiar: {
		body: "small cat-like creature standing on hind legs, fluffy",
		head: "cat-like face with large pointed ears and whiskers",
	},
	Gremlin: {
		body: "small furry creature with oversized hands and feet",
		head: "wide gremlin face with big ears and toothy grin",
	},
	Kobold: {
		body: "small lizard warrior standing upright with a tiny shield",
		head: "small dragon-like head with scales and horn nubs",
	},
	Wisp: {
		body: "floating ethereal orb body with trailing wisps of energy",
		head: "glowing orb face with two bright eye spots",
	},
	Patchling: {
		body: "stitched-together creature made of cloth patches, standing",
		head: "button eyes on a sewn fabric face, yarn hair",
	},
	Bytebug: {
		body: "small insect creature with circuit-board shell pattern",
		head: "bug head with antenna and compound pixel eyes",
	},
	Nullpup: {
		body: "small ghost-dog creature, translucent, floating slightly",
		head: "puppy face fading into void, one eye visible",
	},
	Sparkmote: {
		body: "tiny electric creature made of crackling energy sparks",
		head: "ball of electricity with two bright eye dots",
	},
	// Uncommon - evolved forms
	Drake: {
		body: "young dragon creature with small wings and a scaled tail, standing bipedal",
		head: "dragon head with two small horns, reptilian eyes, small snout",
	},
	Golem: {
		body: "heavy stone construct with chunky rectangular limbs, standing solid",
		head: "blocky stone head with glowing rune eyes, no mouth",
	},
	Wraith: {
		body: "hooded ghostly figure with tattered robes, floating",
		head: "dark hooded face with glowing eyes peering from shadow",
	},
	Basilisk: {
		body: "large serpent creature coiled upright with small arms",
		head: "snake head with crown-like crest and piercing eyes",
	},
	Gryphon: {
		body: "eagle-lion hybrid standing on lion hind legs, wings folded",
		head: "eagle head with sharp beak and fierce eyes",
	},
	Elemental: {
		body: "humanoid made of swirling elemental energy, abstract",
		head: "faceless energy vortex with two glowing eye cores",
	},
	Chimera: {
		body: "three-bodied creature merged together, standing",
		head: "three small heads side by side on one neck",
	},
	Patchbeast: {
		body: "larger stitched creature with armor patches, quadruped",
		head: "fierce patchwork face with mismatched button eyes",
	},
	Voltaur: {
		body: "centaur-like creature crackling with electricity",
		head: "horse-human hybrid face with lightning mane",
	},
	Hexacat: {
		body: "six-legged feline creature standing alert",
		head: "cat face with third eye on forehead, hexagonal pupils",
	},
	Recursaur: {
		body: "dinosaur containing a smaller version of itself in its belly",
		head: "friendly dinosaur head with recursive pattern markings",
	},
	// Rare - powerful beings
	Phoenix: {
		body: "majestic fire bird with spread flame wings, standing",
		head: "bird head wreathed in flames with golden eyes",
	},
	Ent: {
		body: "ancient tree creature with bark skin and branch arms",
		head: "gnarled tree face with hollow eyes and moss beard",
	},
	Djinn: {
		body: "floating genie figure with smoke lower body, crossed arms",
		head: "mystical face with glowing eyes and ornate headdress",
	},
	Wyrm: {
		body: "ancient serpent coiled in a spiral, massive scales",
		head: "elder dragon head with long whiskers and wise eyes",
	},
	Kitsune: {
		body: "nine-tailed fox standing on hind legs, elegant",
		head: "fox face with knowing eyes and multiple ear tips",
	},
	Chocobot: {
		body: "golden mechanical bird standing on two legs",
		head: "bird-robot hybrid head with gear crest and visor eyes",
	},
	Gigavolt: {
		body: "massive electric centaur wreathed in lightning",
		head: "storm face with thunder crown and plasma eyes",
	},
	Mooglemancer: {
		body: "floating small mage creature with pom-pom and staff",
		head: "cute round moogle face with pom-pom antenna",
	},
	// Epic - mythic tier
	Leviathan: {
		body: "massive sea dragon rising from waves, tentacles",
		head: "deep sea dragon head with bioluminescent markings",
	},
	Archon: {
		body: "cosmic judge figure in flowing robes with scales of justice",
		head: "faceless golden mask with radiating light crown",
	},
	Behemoth: {
		body: "impossibly massive creature, like a walking mountain",
		head: "ancient beast head with tusks and glowing eyes",
	},
	Mewtwo: {
		body: "psychic feline humanoid floating with energy aura",
		head: "alien cat face with large purple eyes, sleek",
	},
	Treebeard: {
		body: "massive ancient tree shepherd, towering with root feet",
		head: "deeply wrinkled tree face with amber sap eyes",
	},
	// Legendary - gods
	Bahamut: {
		body: "dragon king in full regal armor with massive wings spread",
		head: "crowned dragon head with diamond eyes and golden horns",
	},
	Sauron: {
		body: "dark lord armored figure with flowing shadow cape",
		head: "great flaming eye within a dark iron helm",
	},
	Arceus: {
		body: "divine quadruped with golden ring around torso, cosmic",
		head: "serene godlike face with emerald eyes and golden crown",
	},
	Sephiroth: {
		body: "one-winged angel in black coat, single white wing",
		head: "silver-haired face with cat-slit green eyes",
	},
};

const STYLE_PREFIX =
	"pixel art character, retro game sprite style, clean edges, flat shading, centered on canvas, front-facing, simple design, dark background removed, transparent background, PNG with alpha channel";

async function generatePart(
	species: string,
	part: "body" | "head",
): Promise<Buffer> {
	const prompts = SPECIES_PROMPTS[species];
	if (!prompts) throw new Error(`Unknown species: ${species}`);

	const partPrompt = part === "body" ? prompts.body : prompts.head;
	const fullPrompt = `${STYLE_PREFIX}, ${partPrompt}, single character ${part} only, isolated on transparent background`;

	console.log(`  Generating ${species} ${part} via ${provider}...`);

	if (provider === "fal") {
		const res = await fetch("https://queue.fal.run/fal-ai/flux/dev", {
			method: "POST",
			headers: {
				Authorization: `Key ${FAL_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt: fullPrompt,
				image_size: { width: 512, height: 512 },
				num_images: 1,
				enable_safety_checker: false,
			}),
		});
		if (!res.ok)
			throw new Error(`Fal.ai error (${res.status}): ${await res.text()}`);
		const data = (await res.json()) as { images: { url: string }[] };
		if (!data.images?.[0]?.url) throw new Error("No image from Fal.ai");
		const imgRes = await fetch(data.images[0].url);
		return Buffer.from(await imgRes.arrayBuffer());
	}

	if (provider === "dalle") {
		const res = await fetch("https://api.openai.com/v1/images/generations", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${OPENAI_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "dall-e-3",
				prompt: fullPrompt,
				n: 1,
				size: "1024x1024",
				quality: "standard",
				response_format: "url",
			}),
		});
		if (!res.ok)
			throw new Error(`DALL-E error (${res.status}): ${await res.text()}`);
		const data = (await res.json()) as { data: { url: string }[] };
		if (!data.data?.[0]?.url) throw new Error("No image from DALL-E");
		const imgRes = await fetch(data.data[0].url);
		return Buffer.from(await imgRes.arrayBuffer());
	}

	if (provider === "replicate") {
		// Use SDXL on Replicate
		const res = await fetch("https://api.replicate.com/v1/predictions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${REPLICATE_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				version:
					"39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
				input: { prompt: fullPrompt, width: 512, height: 512, num_outputs: 1 },
			}),
		});
		if (!res.ok)
			throw new Error(`Replicate error (${res.status}): ${await res.text()}`);
		const prediction = (await res.json()) as {
			id: string;
			urls: { get: string };
		};
		// Poll for completion
		let output: string | undefined;
		for (let i = 0; i < 60; i++) {
			await new Promise((r) => setTimeout(r, 2000));
			const poll = await fetch(prediction.urls.get, {
				headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` },
			});
			const status = (await poll.json()) as {
				status: string;
				output?: string[];
			};
			if (status.status === "succeeded" && status.output?.[0]) {
				output = status.output[0];
				break;
			}
			if (status.status === "failed")
				throw new Error("Replicate prediction failed");
		}
		if (!output) throw new Error("Replicate timeout");
		const imgRes = await fetch(output);
		return Buffer.from(await imgRes.arrayBuffer());
	}

	throw new Error(`Unknown provider: ${provider}`);
}

async function generateSpecies(species: string) {
	const outDir = join(import.meta.dir, "parts", species);

	// Idempotent - skip if parts already exist
	if (
		existsSync(join(outDir, "body.png")) &&
		existsSync(join(outDir, "head.png"))
	) {
		console.log(
			`${species}: parts already exist, skipping (delete parts/${species}/ to regenerate)`,
		);
		return;
	}

	mkdirSync(outDir, { recursive: true });
	console.log(`Generating parts for ${species}...`);

	const bodyBuf = await generatePart(species, "body");
	writeFileSync(join(outDir, "body.png"), bodyBuf);
	console.log(
		`  Saved: parts/${species}/body.png (${(bodyBuf.length / 1024).toFixed(0)} KB)`,
	);

	const headBuf = await generatePart(species, "head");
	writeFileSync(join(outDir, "head.png"), headBuf);
	console.log(
		`  Saved: parts/${species}/head.png (${(headBuf.length / 1024).toFixed(0)} KB)`,
	);

	console.log(`Done: ${species}`);
}

// CLI
const args = process.argv.slice(2);
const speciesFlag =
	args.find((a) => a.startsWith("--species="))?.split("=")[1] ||
	(args.indexOf("--species") >= 0
		? args[args.indexOf("--species") + 1]
		: undefined);

if (!speciesFlag) {
	console.log(
		"Usage: bun run apps/lil-eight/generate-parts.ts --species Drake",
	);
	console.log("       bun run apps/lil-eight/generate-parts.ts --species all");
	console.log(`\nAvailable species (${Object.keys(SPECIES_PROMPTS).length}):`);
	console.log(Object.keys(SPECIES_PROMPTS).join(", "));
	process.exit(0);
}

if (speciesFlag === "all") {
	for (const species of Object.keys(SPECIES_PROMPTS)) {
		await generateSpecies(species);
	}
} else {
	await generateSpecies(speciesFlag);
}
