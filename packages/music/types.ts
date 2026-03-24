/**
 * Music types - genres, tracks, layers, mix configs.
 */

export interface Track {
  id: string;
  path: string;
  genre: Genre;
  bpm: number;
  durationSec: number;
  layers: Layer[];
  createdAt: number;
}

export interface Layer {
  name: string;           // "kick", "bass", "melody", "pad", "hihat", "fx"
  path: string;           // File path to the layer audio
  role: LayerRole;
  volume: number;         // 0-1
  pan: number;            // -1 (left) to 1 (right)
}

export type LayerRole = "drums" | "bass" | "melody" | "pad" | "fx" | "vocal" | "full";

export interface MixConfig {
  genre: Genre;
  bpm: number;
  key?: string;           // Musical key e.g. "Am", "C", "F#m"
  durationSec: number;
  layers: LayerRole[];
  mood?: string;          // "energetic", "chill", "dark", "uplifting"
  loop: boolean;          // Seamless loop
}

export type Genre =
  | "techno" | "house" | "minimal" | "ambient"
  | "drum-and-bass" | "breakbeat" | "trance"
  | "lofi" | "synthwave" | "electro"
  | "dub" | "garage" | "jungle"
  | "downtempo" | "idm";

export const GENRES: Record<Genre, { bpmRange: [number, number]; mood: string; layers: LayerRole[] }> = {
  techno:         { bpmRange: [125, 140], mood: "driving",    layers: ["drums", "bass", "pad", "fx"] },
  house:          { bpmRange: [118, 130], mood: "groovy",     layers: ["drums", "bass", "melody", "pad"] },
  minimal:        { bpmRange: [120, 130], mood: "hypnotic",   layers: ["drums", "bass", "fx"] },
  ambient:        { bpmRange: [60, 90],   mood: "atmospheric", layers: ["pad", "fx", "melody"] },
  "drum-and-bass": { bpmRange: [160, 180], mood: "intense",   layers: ["drums", "bass", "pad"] },
  breakbeat:      { bpmRange: [120, 140], mood: "funky",      layers: ["drums", "bass", "melody", "fx"] },
  trance:         { bpmRange: [130, 145], mood: "euphoric",   layers: ["drums", "bass", "melody", "pad", "fx"] },
  lofi:           { bpmRange: [70, 90],   mood: "chill",      layers: ["drums", "melody", "pad"] },
  synthwave:      { bpmRange: [80, 120],  mood: "nostalgic",  layers: ["drums", "bass", "melody", "pad"] },
  electro:        { bpmRange: [125, 135], mood: "aggressive", layers: ["drums", "bass", "melody", "fx"] },
  dub:            { bpmRange: [60, 80],   mood: "spacious",   layers: ["drums", "bass", "fx", "pad"] },
  garage:         { bpmRange: [128, 135], mood: "bouncy",     layers: ["drums", "bass", "melody", "vocal"] },
  jungle:         { bpmRange: [155, 175], mood: "chaotic",    layers: ["drums", "bass", "pad", "fx"] },
  downtempo:      { bpmRange: [80, 110],  mood: "relaxed",    layers: ["drums", "bass", "melody", "pad"] },
  idm:            { bpmRange: [90, 140],  mood: "experimental", layers: ["drums", "melody", "fx", "pad"] },
};
