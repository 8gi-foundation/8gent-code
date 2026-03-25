/**
 * Notification Preferences - user-configurable notification routing
 *
 * Controls which events trigger notifications, quiet hours,
 * and preferred channels per event type.
 */

// ============================================
// Types
// ============================================

export type NotificationChannel = "desktop" | "telegram" | "none";

export type NotificationEvent =
  | "task-complete"
  | "task-failed"
  | "opportunity-found"
  | "benchmark-result"
  | "session-summary"
  | "memory-consolidation"
  | "revenue-update"
  | "pr-status";

export interface QuietHours {
  enabled: boolean;
  /** 24h format, e.g. "22:00" */
  start: string;
  /** 24h format, e.g. "08:00" */
  end: string;
}

export interface NotificationPreferences {
  /** Global kill switch */
  enabled: boolean;
  /** Channel preference per event type */
  channels: Record<NotificationEvent, NotificationChannel>;
  /** Quiet hours - suppress all non-critical notifications */
  quietHours: QuietHours;
  /** Events that bypass quiet hours */
  criticalEvents: NotificationEvent[];
}

// ============================================
// Defaults
// ============================================

const ALL_EVENTS: NotificationEvent[] = [
  "task-complete",
  "task-failed",
  "opportunity-found",
  "benchmark-result",
  "session-summary",
  "memory-consolidation",
  "revenue-update",
  "pr-status",
];

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  channels: {
    "task-complete": "desktop",
    "task-failed": "desktop",
    "opportunity-found": "none",
    "benchmark-result": "desktop",
    "session-summary": "telegram",
    "memory-consolidation": "none",
    "revenue-update": "telegram",
    "pr-status": "desktop",
  },
  quietHours: {
    enabled: false,
    start: "22:00",
    end: "08:00",
  },
  criticalEvents: ["task-failed"],
};

// ============================================
// Helpers
// ============================================

function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

function isInQuietHours(quiet: QuietHours, now: Date = new Date()): boolean {
  if (!quiet.enabled) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(quiet.start);
  const end = parseTime(quiet.end);
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;

  // Handles overnight ranges (e.g. 22:00 - 08:00)
  if (startMin > endMin) {
    return current >= startMin || current < endMin;
  }
  return current >= startMin && current < endMin;
}

// ============================================
// Core API
// ============================================

/**
 * Resolve which channel to use for a given event, respecting
 * quiet hours and critical overrides.
 */
export function resolveChannel(
  event: NotificationEvent,
  prefs: NotificationPreferences = DEFAULT_PREFERENCES,
  now: Date = new Date(),
): NotificationChannel {
  if (!prefs.enabled) return "none";

  const channel = prefs.channels[event] ?? "none";
  if (channel === "none") return "none";

  // Quiet hours check - critical events bypass
  if (isInQuietHours(prefs.quietHours, now)) {
    if (!prefs.criticalEvents.includes(event)) {
      return "none";
    }
  }

  return channel;
}

/**
 * Check whether a given event should fire right now.
 */
export function shouldNotify(
  event: NotificationEvent,
  prefs: NotificationPreferences = DEFAULT_PREFERENCES,
  now: Date = new Date(),
): boolean {
  return resolveChannel(event, prefs, now) !== "none";
}

/**
 * Merge partial user overrides onto the defaults.
 */
export function mergePreferences(
  overrides: Partial<NotificationPreferences>,
): NotificationPreferences {
  return {
    enabled: overrides.enabled ?? DEFAULT_PREFERENCES.enabled,
    channels: { ...DEFAULT_PREFERENCES.channels, ...overrides.channels },
    quietHours: { ...DEFAULT_PREFERENCES.quietHours, ...overrides.quietHours },
    criticalEvents: overrides.criticalEvents ?? DEFAULT_PREFERENCES.criticalEvents,
  };
}

/**
 * List all known event types.
 */
export function listEvents(): NotificationEvent[] {
  return [...ALL_EVENTS];
}
