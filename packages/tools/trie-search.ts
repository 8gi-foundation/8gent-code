/**
 * Prefix Trie for fast autocomplete and command lookup.
 * Self-contained, no dependencies.
 */

interface TrieNode {
  children: Map<string, TrieNode>;
  isEnd: boolean;
  count: number;
}

function createNode(): TrieNode {
  return { children: new Map(), isEnd: false, count: 0 };
}

export class Trie {
  private root: TrieNode = createNode();
  private _wordCount = 0;

  /** Insert a word into the trie. */
  insert(word: string): void {
    if (!word) return;
    let node = this.root;
    for (const ch of word) {
      if (!node.children.has(ch)) {
        node.children.set(ch, createNode());
      }
      node = node.children.get(ch)!;
      node.count++;
    }
    if (!node.isEnd) {
      node.isEnd = true;
      this._wordCount++;
    }
  }

  /** Returns true if the exact word exists. */
  search(word: string): boolean {
    const node = this._traverse(word);
    return node !== null && node.isEnd;
  }

  /** Returns true if any word starts with the given prefix. */
  startsWith(prefix: string): boolean {
    return this._traverse(prefix) !== null;
  }

  /**
   * Returns up to `limit` words that begin with prefix.
   * Words are returned in insertion/depth-first order.
   */
  suggest(prefix: string, limit = 10): string[] {
    const node = this._traverse(prefix);
    if (!node) return [];
    const results: string[] = [];
    this._collect(node, prefix, results, limit);
    return results;
  }

  /**
   * Delete a word from the trie.
   * Returns true if the word existed and was removed.
   */
  delete(word: string): boolean {
    if (!this.search(word)) return false;
    this._delete(this.root, word, 0);
    this._wordCount--;
    return true;
  }

  /** Total number of unique words stored. */
  wordCount(): number {
    return this._wordCount;
  }

  // --- private helpers ---

  private _traverse(s: string): TrieNode | null {
    let node = this.root;
    for (const ch of s) {
      if (!node.children.has(ch)) return null;
      node = node.children.get(ch)!;
    }
    return node;
  }

  private _collect(
    node: TrieNode,
    current: string,
    results: string[],
    limit: number
  ): void {
    if (results.length >= limit) return;
    if (node.isEnd) results.push(current);
    for (const [ch, child] of node.children) {
      if (results.length >= limit) break;
      this._collect(child, current + ch, results, limit);
    }
  }

  private _delete(node: TrieNode, word: string, depth: number): boolean {
    if (depth === word.length) {
      node.isEnd = false;
      return node.children.size === 0;
    }
    const ch = word[depth];
    const child = node.children.get(ch);
    if (!child) return false;
    child.count--;
    const shouldDelete = this._delete(child, word, depth + 1);
    if (shouldDelete) node.children.delete(ch);
    return !node.isEnd && node.children.size === 0;
  }
}
