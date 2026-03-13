import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let scene: any, timeline: any, exporter: any;

beforeEach(async () => {
  try {
    scene = await import(path.join(WORK_DIR, "scene.ts"));
    timeline = await import(path.join(WORK_DIR, "timeline.ts"));
    exporter = await import(path.join(WORK_DIR, "exporter.ts"));
  } catch {}
});

describe("Scene", () => {
  it("creates a scene with id, duration, and type", () => {
    const Scene = scene.Scene || scene.default;
    const s = new Scene("intro-1", 5000, "intro");
    expect(s.id).toBe("intro-1");
    expect(s.duration).toBe(5000);
    expect(s.type).toBe("intro");
  });

  it("adds and retrieves assets", () => {
    const Scene = scene.Scene || scene.default;
    const s = new Scene("main-1", 10000, "main");
    s.addAsset({ type: "video", src: "clip1.mp4", startTime: 0, endTime: 5000 });
    s.addAsset({ type: "audio", src: "bgm.mp3", startTime: 0, endTime: 10000 });
    expect(s.getAssets().length).toBe(2);
    expect(s.getAssets()[0].src).toBe("clip1.mp4");
  });

  it("removes an asset by src", () => {
    const Scene = scene.Scene || scene.default;
    const s = new Scene("main-1", 10000, "main");
    s.addAsset({ type: "video", src: "clip1.mp4", startTime: 0, endTime: 5000 });
    s.addAsset({ type: "image", src: "bg.png", startTime: 0, endTime: 10000 });
    s.removeAsset("clip1.mp4");
    expect(s.getAssets().length).toBe(1);
    expect(s.getAssets()[0].src).toBe("bg.png");
  });

  it("adds and retrieves effects", () => {
    const Scene = scene.Scene || scene.default;
    const s = new Scene("transition-1", 2000, "transition");
    s.addEffect({ type: "fade", duration: 500 });
    s.addEffect({ type: "dissolve", duration: 1000, params: { opacity: 0.5 } });
    expect(s.getEffects().length).toBe(2);
    expect(s.getEffects()[0].type).toBe("fade");
  });
});

describe("Timeline", () => {
  it("adds scenes and calculates total duration", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 3000, "intro"));
    tl.addScene(new Scene("s2", 5000, "main"));
    tl.addScene(new Scene("s3", 2000, "outro"));
    expect(tl.getTotalDuration()).toBe(10000);
  });

  it("removes a scene by id", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 3000, "intro"));
    tl.addScene(new Scene("s2", 5000, "main"));
    const removed = tl.removeScene("s1");
    expect(removed).toBe(true);
    expect(tl.getTotalDuration()).toBe(5000);
  });

  it("removeScene returns false for nonexistent id", () => {
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    expect(tl.removeScene("nope")).toBe(false);
  });

  it("reorders scenes by id array", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("a", 1000, "intro"));
    tl.addScene(new Scene("b", 2000, "main"));
    tl.addScene(new Scene("c", 3000, "outro"));
    tl.reorderScenes(["c", "a", "b"]);
    const scenes = tl.getScenes();
    expect(scenes[0].id).toBe("c");
    expect(scenes[1].id).toBe("a");
    expect(scenes[2].id).toBe("b");
  });

  it("getSceneAt returns correct scene for given time", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 3000, "intro"));
    tl.addScene(new Scene("s2", 5000, "main"));
    tl.addScene(new Scene("s3", 2000, "outro"));
    expect(tl.getSceneAt(0)!.id).toBe("s1");
    expect(tl.getSceneAt(2999)!.id).toBe("s1");
    expect(tl.getSceneAt(3000)!.id).toBe("s2");
    expect(tl.getSceneAt(8000)!.id).toBe("s3");
  });

  it("getSceneAt returns null for time beyond total", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 3000, "intro"));
    expect(tl.getSceneAt(5000)).toBeNull();
  });

  it("splitScene splits a scene at the given offset", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 10000, "main"));
    const [a, b] = tl.splitScene("s1", 4000);
    expect(a.duration).toBe(4000);
    expect(b.duration).toBe(6000);
  });

  it("validate detects valid contiguous timeline", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 3000, "intro"));
    tl.addScene(new Scene("s2", 5000, "main"));
    const result = tl.validate();
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("toEDL returns a string with one line per scene", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 3000, "intro"));
    tl.addScene(new Scene("s2", 5000, "main"));
    const edl = tl.toEDL();
    expect(typeof edl).toBe("string");
    const lines = edl.trim().split("\n").filter((l: string) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Exporter", () => {
  it("generateFFmpegCommand returns string with ffmpeg and resolution", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 5000, "main"));
    const config = { format: "mp4" as const, resolution: { w: 1920, h: 1080 }, fps: 30 };
    const cmd = exporter.generateFFmpegCommand(tl, config);
    expect(cmd).toContain("ffmpeg");
    expect(cmd).toContain("1920");
    expect(cmd).toContain("1080");
    expect(cmd).toContain("mp4");
  });

  it("generateFFmpegCommand includes codec when specified", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 5000, "main"));
    const config = { format: "mp4" as const, resolution: { w: 1280, h: 720 }, fps: 24, codec: "libx264" };
    const cmd = exporter.generateFFmpegCommand(tl, config);
    expect(cmd).toContain("libx264");
  });

  it("estimateFileSize returns a positive number", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    tl.addScene(new Scene("s1", 10000, "main"));
    const config = { format: "mp4" as const, resolution: { w: 1920, h: 1080 }, fps: 30 };
    const size = exporter.estimateFileSize(tl, config);
    expect(size).toBeGreaterThan(0);
    expect(typeof size).toBe("number");
  });

  it("generateShotList returns markdown table string", () => {
    const Scene = scene.Scene || scene.default;
    const Timeline = timeline.Timeline || timeline.default;
    const tl = new Timeline();
    const s1 = new Scene("s1", 3000, "intro");
    s1.addAsset({ type: "video", src: "intro.mp4", startTime: 0, endTime: 3000 });
    tl.addScene(s1);
    tl.addScene(new Scene("s2", 5000, "main"));
    const shotList = exporter.generateShotList(tl);
    expect(typeof shotList).toBe("string");
    expect(shotList).toContain("s1");
    expect(shotList).toContain("|");
  });
});
