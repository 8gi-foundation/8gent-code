/**
 * Configuration for motion animations.
 */
interface MotionConfig {
  duration: number;
  easing: string;
  enabled: boolean;
}

/**
 * Checks if the user has prefers-reduced-motion enabled.
 * @param mediaQueryList - Optional MediaQueryList to check. Defaults to the current window's media query.
 * @returns True if reduced motion is preferred.
 */
function isReduced(mediaQueryList?: MediaQueryList): boolean {
  const mq = mediaQueryList || window.matchMedia('(prefers-reduced-motion: reduce)');
  return mq.matches;
}

/**
 * Returns a motion config with zero duration if reduced motion is preferred.
 * @param config - The original motion config.
 * @returns Modified config with zero duration if reduced motion is preferred.
 */
function reduced(config: MotionConfig): MotionConfig {
  if (isReduced()) {
    return { ...config, duration: 0 };
  }
  return config;
}

/**
 * Returns the appropriate motion config based on user preference.
 * @param full - Config to use when motion is not reduced.
 * @param reduced - Config to use when motion is reduced.
 * @returns The selected config.
 */
function withMotion(full: MotionConfig, reduced: MotionConfig): MotionConfig {
  return isReduced() ? reduced : full;
}

export { MotionConfig, isReduced, reduced, withMotion };