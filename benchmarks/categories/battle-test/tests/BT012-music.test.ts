import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let theory: any, chord: any, progression: any;

beforeEach(async () => {
  try {
    theory = await import(path.join(WORK_DIR, "theory.ts"));
    chord = await import(path.join(WORK_DIR, "chord.ts"));
    progression = await import(path.join(WORK_DIR, "progression.ts"));
  } catch {}
});

describe("Theory — Note Utilities", () => {
  it("NOTES contains all 12 chromatic notes", () => {
    const NOTES = theory.NOTES || theory.default?.NOTES;
    expect(NOTES.length).toBe(12);
    expect(NOTES[0]).toBe("C");
    expect(NOTES[11]).toBe("B");
  });

  it("noteToMidi returns 60 for C4", () => {
    const noteToMidi = theory.noteToMidi || theory.default?.noteToMidi;
    expect(noteToMidi("C", 4)).toBe(60);
  });

  it("noteToMidi returns 69 for A4", () => {
    const noteToMidi = theory.noteToMidi || theory.default?.noteToMidi;
    expect(noteToMidi("A", 4)).toBe(69);
  });

  it("midiToNote converts 60 back to C4", () => {
    const midiToNote = theory.midiToNote || theory.default?.midiToNote;
    const result = midiToNote(60);
    expect(result.note).toBe("C");
    expect(result.octave).toBe(4);
  });

  it("transpose wraps forward: B + 1 = C", () => {
    const transpose = theory.transpose || theory.default?.transpose;
    expect(transpose("B", 1)).toBe("C");
  });

  it("transpose wraps backward: C - 1 = B", () => {
    const transpose = theory.transpose || theory.default?.transpose;
    expect(transpose("C", -1)).toBe("B");
  });

  it("transpose by 0 returns same note", () => {
    const transpose = theory.transpose || theory.default?.transpose;
    expect(transpose("E", 0)).toBe("E");
  });

  it("getInterval returns correct interval names", () => {
    const getInterval = theory.getInterval || theory.default?.getInterval;
    expect(getInterval("C", "C")).toBe("unison");
    expect(getInterval("C", "G")).toBe("perfect5");
    expect(getInterval("C", "E")).toBe("major3");
  });

  it("SCALE_PATTERNS has major and minor patterns", () => {
    const SCALE_PATTERNS = theory.SCALE_PATTERNS || theory.default?.SCALE_PATTERNS;
    expect(SCALE_PATTERNS.major).toEqual([2, 2, 1, 2, 2, 2, 1]);
    expect(SCALE_PATTERNS.minor).toEqual([2, 1, 2, 2, 1, 2, 2]);
  });

  it("getScale returns correct C major scale", () => {
    const getScale = theory.getScale || theory.default?.getScale;
    const scale = getScale("C", "major");
    expect(scale[0]).toBe("C");
    expect(scale[1]).toBe("D");
    expect(scale[2]).toBe("E");
    expect(scale[3]).toBe("F");
    expect(scale[4]).toBe("G");
  });

  it("SCALE_PATTERNS includes pentatonic and blues", () => {
    const SCALE_PATTERNS = theory.SCALE_PATTERNS || theory.default?.SCALE_PATTERNS;
    expect(SCALE_PATTERNS.pentatonic).toBeDefined();
    expect(SCALE_PATTERNS.blues).toBeDefined();
    expect(SCALE_PATTERNS.pentatonic.length).toBe(5);
    expect(SCALE_PATTERNS.blues.length).toBe(6);
  });
});

describe("Chord", () => {
  it("constructs a major chord with correct notes", () => {
    const Chord = chord.Chord || chord.default;
    const c = new Chord("C", "major");
    const notes = c.getNotes();
    expect(notes).toContain("C");
    expect(notes).toContain("E");
    expect(notes).toContain("G");
    expect(notes.length).toBe(3);
  });

  it("constructs a minor chord", () => {
    const Chord = chord.Chord || chord.default;
    const c = new Chord("A", "minor");
    const notes = c.getNotes();
    expect(notes).toContain("A");
    expect(notes).toContain("C");
    expect(notes).toContain("E");
  });

  it("constructs a dom7 chord with 4 notes", () => {
    const Chord = chord.Chord || chord.default;
    const c = new Chord("G", "dom7");
    const notes = c.getNotes();
    expect(notes.length).toBe(4);
    expect(notes).toContain("G");
    expect(notes).toContain("F");
  });

  it("toSymbol returns correct symbols", () => {
    const Chord = chord.Chord || chord.default;
    expect(new Chord("C", "major").toSymbol()).toBe("C");
    expect(new Chord("A", "minor").toSymbol()).toBe("Am");
    expect(new Chord("C", "maj7").toSymbol()).toBe("Cmaj7");
    expect(new Chord("G", "dom7").toSymbol()).toBe("G7");
  });

  it("fromSymbol parses chord symbols correctly", () => {
    const Chord = chord.Chord || chord.default;
    const am = Chord.fromSymbol("Am");
    expect(am.root).toBe("A");
    expect(am.quality).toBe("minor");
    const g7 = Chord.fromSymbol("G7");
    expect(g7.root).toBe("G");
    expect(g7.quality).toBe("dom7");
    const bdim = Chord.fromSymbol("Bdim");
    expect(bdim.root).toBe("B");
    expect(bdim.quality).toBe("diminished");
  });

  it("invert rotates notes", () => {
    const Chord = chord.Chord || chord.default;
    const c = new Chord("C", "major");
    const inv1 = c.invert(1);
    expect(inv1[0]).toBe("E");
    expect(inv1.length).toBe(3);
  });
});

describe("ChordProgression", () => {
  it("adds chords and retrieves them", () => {
    const Chord = chord.Chord || chord.default;
    const CP = progression.ChordProgression || progression.default;
    const prog = new CP("C", "major");
    prog.addChord(new Chord("C", "major"));
    prog.addChord(new Chord("G", "major"));
    expect(prog.getChords().length).toBe(2);
  });

  it("analyze returns roman numerals for I-V-vi-IV", () => {
    const Chord = chord.Chord || chord.default;
    const CP = progression.ChordProgression || progression.default;
    const prog = new CP("C", "major");
    prog.addChord(new Chord("C", "major"));
    prog.addChord(new Chord("G", "major"));
    prog.addChord(new Chord("A", "minor"));
    prog.addChord(new Chord("F", "major"));
    const analysis = prog.analyze();
    expect(analysis.romanNumerals).toBeDefined();
    expect(analysis.romanNumerals.length).toBe(4);
    expect(analysis.tensions).toBeDefined();
  });

  it("transpose returns a new progression in different key", () => {
    const Chord = chord.Chord || chord.default;
    const CP = progression.ChordProgression || progression.default;
    const prog = new CP("C", "major");
    prog.addChord(new Chord("C", "major"));
    prog.addChord(new Chord("F", "major"));
    const transposed = prog.transpose(2);
    expect(transposed.key).toBe("D");
    const chords = transposed.getChords();
    expect(chords[0].root).toBe("D");
    expect(chords[1].root).toBe("G");
  });

  it("suggest returns arrays of chord progressions", () => {
    const CP = progression.ChordProgression || progression.default;
    const prog = new CP("C", "major");
    const suggestions = prog.suggest(4);
    expect(Array.isArray(suggestions)).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].length).toBe(4);
  });

  it("toNashvilleNumbers returns string array", () => {
    const Chord = chord.Chord || chord.default;
    const CP = progression.ChordProgression || progression.default;
    const prog = new CP("C", "major");
    prog.addChord(new Chord("C", "major"));
    prog.addChord(new Chord("G", "major"));
    const nashville = prog.toNashvilleNumbers();
    expect(Array.isArray(nashville)).toBe(true);
    expect(nashville.length).toBe(2);
    expect(nashville[0]).toBe("1");
    expect(nashville[1]).toBe("5");
  });
});
