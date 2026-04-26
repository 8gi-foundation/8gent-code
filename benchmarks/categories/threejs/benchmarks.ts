/**
 * 8gent Code Benchmarks - Three.js / 3D Development
 *
 * Tests 3D graphics programming skills with Three.js
 */

import type { BenchmarkDefinition } from "../../types";

export const threejsBenchmarks: BenchmarkDefinition[] = [
	{
		id: "3D001",
		name: "Create Rotating Cube Scene",
		category: "threejs",
		difficulty: "easy",
		description:
			"Set up a basic Three.js scene with a rotating cube, lighting, and camera controls",
		task: `Create a Three.js scene with:
1. A colored cube that rotates continuously
2. Ambient and directional lighting
3. OrbitControls for camera manipulation
4. Responsive canvas that fills the viewport
5. Animation loop using requestAnimationFrame`,
		expectedBehavior:
			"Cube should rotate smoothly, respond to mouse drag for orbit, and resize with window",
		fixture: "fixtures/threejs/3D001-empty-scene.ts",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Scene renders without errors",
					"Cube is visible and rotating",
					"Lighting illuminates the cube correctly",
					"OrbitControls work for camera rotation",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: [
					"Clean separation of setup and render loop",
					"Proper cleanup on unmount",
					"Typed parameters for TypeScript",
				],
			},
			efficiency: {
				weight: 20,
				criteria: [
					"Uses BufferGeometry",
					"Disposes of resources properly",
					"Single render loop",
				],
			},
			bestPractices: {
				weight: 15,
				criteria: [
					"Follows Three.js naming conventions",
					"Uses const for non-reassigned variables",
					"Handles window resize",
				],
			},
		},
		validators: [
			{
				type: "ast",
				config: {
					mustContain: [
						"THREE.Scene",
						"THREE.PerspectiveCamera",
						"requestAnimationFrame",
					],
				},
			},
			{ type: "execution", config: { timeout: 5000, expectNoErrors: true } },
		],
		expectedTokens: 800,
		timeLimit: 120,
	},
	{
		id: "3D002",
		name: "Load and Animate 3D Model",
		category: "threejs",
		difficulty: "medium",
		description: "Load a GLTF model and implement animation playback",
		task: `Create a Three.js application that:
1. Loads a GLTF model from a URL
2. Plays embedded animations using AnimationMixer
3. Adds UI controls to play/pause/stop animation
4. Centers and scales the model appropriately
5. Adds environment lighting with HDR`,
		expectedBehavior:
			"Model loads, animations play smoothly, controls work, lighting looks natural",
		fixture: "fixtures/threejs/3D002-model-loader.ts",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Model loads successfully",
					"Animations play correctly",
					"UI controls function",
					"Model is properly scaled and centered",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: [
					"Async/await for loading",
					"Error handling for load failures",
					"Proper animation cleanup",
				],
			},
			efficiency: {
				weight: 20,
				criteria: [
					"Caches loaded models",
					"Disposes of animations on cleanup",
					"Efficient update loop",
				],
			},
			bestPractices: {
				weight: 15,
				criteria: [
					"Uses GLTFLoader from three/examples",
					"Proper loading progress feedback",
					"Handles missing animations gracefully",
				],
			},
		},
		validators: [
			{
				type: "ast",
				config: { mustContain: ["GLTFLoader", "AnimationMixer", "clipAction"] },
			},
		],
		expectedTokens: 1200,
		timeLimit: 180,
	},
	{
		id: "3D003",
		name: "Custom Shader Material",
		category: "threejs",
		difficulty: "hard",
		description: "Create a custom shader with uniforms and real-time updates",
		task: `Create a custom ShaderMaterial that:
1. Implements a pulsing glow effect
2. Uses uniforms for color and intensity
3. Responds to mouse position
4. Includes both vertex and fragment shaders
5. Animates smoothly over time`,
		expectedBehavior:
			"Object glows with pulsing animation, responds to mouse, color can be changed",
		fixture: "fixtures/threejs/3D003-custom-shader.ts",
		rubric: {
			correctness: {
				weight: 40,
				criteria: [
					"Shader compiles without errors",
					"Glow effect is visible",
					"Mouse interaction works",
					"Time-based animation is smooth",
				],
			},
			codeQuality: {
				weight: 25,
				criteria: [
					"GLSL code is well-structured",
					"Uniforms are properly declared",
					"TypeScript types for uniforms",
				],
			},
			efficiency: {
				weight: 20,
				criteria: [
					"Minimal uniform updates",
					"Efficient GLSL calculations",
					"No redundant draw calls",
				],
			},
			bestPractices: {
				weight: 15,
				criteria: [
					"Uses template literals for shader code",
					"Clamps values to valid ranges",
					"Follows GLSL naming conventions",
				],
			},
		},
		validators: [
			{
				type: "ast",
				config: {
					mustContain: [
						"ShaderMaterial",
						"vertexShader",
						"fragmentShader",
						"uniforms",
					],
				},
			},
		],
		expectedTokens: 1500,
		timeLimit: 240,
	},
];

export default threejsBenchmarks;
