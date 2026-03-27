/**
 * DiscordRest - Simple Discord REST API client for posting messages.
 *
 * Holds a map of memberCode -> bot token. Supports posting messages
 * and triggering typing indicators. No heavy deps.
 */

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordRest {
  private tokens: Map<string, string>; // memberCode -> bot token

  constructor(tokens: Map<string, string>) {
    this.tokens = tokens;
  }

  async postMessage(memberCode: string, channelId: string, content: string): Promise<boolean> {
    const token = this.tokens.get(memberCode);
    if (!token) {
      console.error(`[discord-rest] no token for ${memberCode}`);
      return false;
    }

    // Discord limit is 2000 chars
    const body = content.length > 1950 ? content.slice(0, 1950) + "..." : content;

    try {
      const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: body }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[discord-rest] ${memberCode} post failed: ${res.status} ${text}`);
        return false;
      }

      return true;
    } catch (err) {
      console.error(`[discord-rest] ${memberCode} post error:`, err);
      return false;
    }
  }

  async setTyping(memberCode: string, channelId: string): Promise<void> {
    const token = this.tokens.get(memberCode);
    if (!token) return;

    try {
      await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
        },
      });
    } catch {
      // Typing indicator is best-effort, ignore failures
    }
  }

  hasToken(memberCode: string): boolean {
    return this.tokens.has(memberCode);
  }
}
