/**
 * @8gent/music - Multi-instrumentalist AI Music Production
 *
 * Combines multiple backends for layered music generation:
 * - Replicate (MusicGen, Riffusion) for AI composition
 * - sox for synthesis, effects, mixing
 * - ffmpeg for encoding, looping, mastering
 * - afplay for local playback
 *
 * Eight becomes a DJ, producer, and multi-instrumentalist.
 */

export { MusicProducer } from "./producer.js";
export { SoxSynth } from "./sox-synth.js";
export { ReplicateBackend } from "./replicate.js";
export { Mixer } from "./mixer.js";
export { Player } from "./player.js";
export { GENRES, type Genre, type Track, type MixConfig, type Layer } from "./types.js";
export { DJ } from "./dj.js";
