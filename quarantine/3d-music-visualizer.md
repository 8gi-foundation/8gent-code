# Quarantine: 3D Music Visualizer (Omma/Spline Approach)

## What Omma/Spline Showed

Spline paired with Omma to demo a 3D interactive music app using WebGPU - real-time reflections, sound-based mesh deformation, a synth/mixer built entirely in the browser. The key pattern: WebGPU shaders driven by Web Audio API frequency data, with Spline as the authoring tool.

## Core Pattern (1 sentence)

Audio frequency bins mapped to 3D mesh transforms (scale, position, color) via requestAnimationFrame, with Web Audio API's AnalyserNode as the data source.

## Can We Rebuild in <200 Lines?

**Yes.** The core loop is:
1. Web Audio API AnalyserNode - getByteFrequencyData() each frame
2. Map frequency bins to mesh properties (bar heights, sphere displacement, color intensity)
3. Three.js handles rendering - no WebGPU required for the effect

Spline is a design tool (proprietary). Three.js gives us the same runtime result with zero vendor lock-in.

## Does It Solve a Problem We Have Today?

**Partially.** Eight already has `packages/music/` with DJ, radio, and producer capabilities. The TUI has a `MusicPlayer.tsx` widget. A browser-based 3D visualizer could:
- Serve as a standalone demo of Eight's music power
- Be embedded in 8gent.app or 8gent.world as a showcase
- Eventually feed into the CLUI (Tauri webview) as a real visualizer

What it does NOT do: improve audio playback, add new music features, or change the TUI experience directly.

## Smallest Proof

A single HTML file (~200 lines) with Three.js from CDN, Web Audio API, and a microphone/file input. Opens in any browser. No build step.

## Risk Assessment

- **Vendor lock-in:** None (Three.js is MIT, Web Audio is a web standard)
- **Complexity added:** 1 file, no dependencies on existing packages
- **WebGPU:** Not needed for this proof. Three.js WebGLRenderer is sufficient. WebGPU can be explored later if performance demands it.

## Integration Path (if proven)

1. Standalone HTML proof (this PR)
2. If compelling, wrap as a component in 8gent.app (React Three Fiber)
3. Could feed into CLUI Tauri webview for desktop visualizer
4. Could connect to Eight's music package via WebSocket for real playback data

## Decision

**Quarantine as standalone proof.** Does not touch existing code. Evaluate after demo.
