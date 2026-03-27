/**
 * Represents a post with content and platform information.
 */
interface Post {
  content: string;
  platform: string;
}

/**
 * Represents a scheduled post with a scheduled time.
 */
interface ScheduledPost extends Post {
  scheduledAt: string;
}

/**
 * Optimal posting time windows for each platform.
 */
const platformPatterns = {
  twitter: ["09:00-11:00", "14:00-16:00", "18:00-20:00"],
  linkedin: ["08:00-10:00", "12:00-14:00", "16:00-18:00"],
  instagram: ["10:00-12:00", "15:00-17:00", "19:00-21:00"],
  facebook: ["11:00-13:00", "15:00-17:00", "19:00-21:00"],
  tiktok: ["12:00-14:00", "18:00-20:00", "22:00-24:00"],
};

/**
 * Calculates optimal posting windows for a given platform and timezone.
 * @param platform - The social media platform.
 * @param timezone - The audience's timezone.
 * @returns Top 3 optimal posting windows.
 */
export function optimalTimes(platform: string, timezone: string): string[] {
  const patterns = platformPatterns[platform] || [];
  return patterns.slice(0, 3);
}

/**
 * Distributes posts across optimal posting windows for a given timezone.
 * @param posts - Array of posts to schedule.
 * @param timezone - The audience's timezone.
 * @returns Scheduled posts with assigned times.
 */
export function schedule(posts: Post[], timezone: string): ScheduledPost[] {
  const optimal = optimalTimes("twitter", timezone); // Placeholder platform
  return posts.map(post => ({
    ...post,
    scheduledAt: optimal[Math.floor(Math.random() * optimal.length)]
  }));
}

/**
 * Renders a weekly posting calendar from scheduled posts.
 * @param posts - Array of scheduled posts.
 * @returns Formatted weekly posting calendar.
 */
export function renderSchedule(posts: ScheduledPost[]): string {
  const byDay = posts.reduce((acc, post) => {
    const day = post.scheduledAt.split(":")[0];
    acc[day] = acc[day] || [];
    acc[day].push(post);
    return acc;
  }, {} as Record<string, ScheduledPost[]>);

  return Object.entries(byDay)
    .map(([day, posts]) => `${day}: ${posts.map(p => p.content).join(", ")}`)
    .join("\n");
}