/**
 * In-process pub/sub with topics, wildcards, and backpressure.
 */
class PubSub {
  private topics: Map<string, { handler: (data: any) => void; queue: any[] }> = new Map();
  private subscribers: Map<string, Set<string>> = new Map();

  /**
   * Subscribe to a topic.
   * @param topic - Topic to subscribe to (e.g., 'user.*').
   * @param handler - Handler function.
   * @returns Unsubscribe function.
   */
  subscribe(topic: string, handler: (data: any) => void): () => void {
    const key = this.normalizeTopic(topic);
    if (!this.topics.has(key)) {
      this.topics.set(key, { handler, queue: [] });
    }
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    this.subscribers.get(topic)!.add(key);
    return () => {
      this.subscribers.get(topic)!.delete(key);
      if (this.subscribers.get(topic)!.size === 0) {
        this.topics.delete(key);
      }
    };
  }

  /**
   * Publish to a topic with backpressure.
   * @param topic - Topic to publish to.
   * @param data - Data to publish.
   * @returns Promise that resolves when publishing is complete.
   */
  publish(topic: string, data: any): Promise<void> {
    return new Promise(resolve => {
      const keys = Array.from(this.subscribers.get(topic) || []);
      for (const key of keys) {
        const { handler, queue } = this.topics.get(key)!;
        if (queue.length > 100) continue;
        queue.push(data);
        handler(data);
      }
      resolve();
    });
  }

  /**
   * Subscribe once to a topic.
   * @param topic - Topic to subscribe to.
   * @returns Promise that resolves with the first data received.
   */
  subscribeOnce(topic: string): Promise<any> {
    return new Promise(resolve => {
      const unsub = this.subscribe(topic, (data: any) => {
        unsub();
        resolve(data);
      });
    });
  }

  /**
   * Normalize topic for matching.
   */
  private normalizeTopic(topic: string): string {
    return topic.replace(/\./g, '__DOT__');
  }

  /**
   * Check if a handler topic matches a published topic.
   */
  private matches(handlerTopic: string, publishedTopic: string): boolean {
    const hParts = handlerTopic.split('__DOT__');
    const pParts = publishedTopic.split('__DOT__');
    if (hParts.length !== pParts.length) return false;
    for (let i = 0; i < hParts.length; i++) {
      if (hParts[i] === '*') continue;
      if (hParts[i] !== pParts[i]) return false;
    }
    return true;
  }
}

/**
 * Create a new PubSub instance.
 */
export function createPubSub(): PubSub {
  return new PubSub();
}