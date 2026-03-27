/**
 * Video script builder utility
 */
export interface Script {
  title: string;
  duration: string;
  audience: string;
  goal: string;
  segments: Segment[];
}

export interface Segment {
  timecode: string;
  narration: string;
  visual: string;
  bRoll?: string;
}

/**
 * Create a new video script
 * @param title - Video title
 * @param duration - Video duration (MM:SS format)
 * @param audience - Target audience
 * @param goal - Video goal
 * @returns New script object
 */
export function buildScript({ title, duration, audience, goal }: { title: string; duration: string; audience: string; goal: string }): Script {
  return { title, duration, audience, goal, segments: [] };
}

/**
 * Add a segment to the script
 * @param script - Target script
 * @param segment - Segment details
 * @returns Updated script
 */
export function addSegment(script: Script, { timecode, narration, visual, bRoll }: { timecode: string; narration: string; visual: string; bRoll?: string }): Script {
  if (!/^\d{2}:\d{2}$/.test(timecode)) {
    throw new Error("Timecode must be in MM:SS format");
  }
  script.segments.push({ timecode, narration, visual, bRoll });
  return script;
}

/**
 * Generate attention-grabbing hook
 * @param topic - Main topic
 * @param style - Optional style (question/declaration)
 * @returns Hook text
 */
export function hook(topic: string, style: "question" | "declaration" = "declaration"): string {
  if (style === "question") {
    return `Did you know ${topic} could change everything?`;
  }
  return `Imagine a world where ${topic} is no longer a problem.`;
}

/**
 * Generate platform-appropriate CTA
 * @param goal - Video goal
 * @param platform - Target platform
 * @returns CTA text
 */
export function cta(goal: string, platform: "youtube" | "instagram"): string {
  if (platform === "youtube") {
    return `Subscribe now to learn how to ${goal} effectively.`;
  }
  return `Tap the link in bio to start ${goal} today!`;
}

/**
 * Generate teleprompter view
 * @param script - Target script
 * @returns Clean narration text
 */
export function renderTeleprompter(script: Script): string {
  return script.segments.map(s => s.narration).join("\n\n");
}