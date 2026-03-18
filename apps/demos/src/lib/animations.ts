import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/** Fade in with optional slide-up */
export function useFadeIn(delay = 0, slideDistance = 30) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 20, stiffness: 100 },
  });

  return {
    opacity: progress,
    transform: `translateY(${interpolate(progress, [0, 1], [slideDistance, 0])}px)`,
  };
}

/** Scale in with bounce */
export function useScaleIn(delay = 0) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 12, stiffness: 150 },
  });

  return {
    opacity: progress,
    transform: `scale(${interpolate(progress, [0, 1], [0.5, 1])})`,
  };
}

/** Typewriter effect — returns number of chars to show */
export function useTypewriter(text: string, delay = 0, charsPerFrame = 1.5) {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);
  const chars = Math.min(
    text.length,
    Math.floor(adjustedFrame * charsPerFrame)
  );
  return text.slice(0, chars);
}

/** Pulsing glow intensity (0–1) */
export function useGlow(speed = 0.05) {
  const frame = useCurrentFrame();
  return 0.5 + 0.5 * Math.sin(frame * speed);
}

/** Counter that animates from 0 to target */
export function useCounter(target: number, delay = 0, duration = 30) {
  const frame = useCurrentFrame();
  const progress = interpolate(frame - delay, [0, duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return Math.round(target * progress);
}
