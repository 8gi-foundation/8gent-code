/**
 * Represents a node in the rope data structure.
 */
class Node {
  left: Node | null;
  right: Node | null;
  size: number;
  value: string | null;

  constructor(value: string | null, left: Node | null, right: Node | null) {
    this.value = value;
    this.left = left;
    this.right = right;
    this.size = (value ? value.length : 0) + (left ? left.size : 0) + (right ? right.size : 0);
  }
}

/**
 * Rope data structure for efficient large text editing.
 */
export class Rope {
  private root: Node | null;

  /**
   * Creates a new Rope instance.
   * @param text Initial text to populate the rope.
   */
  constructor(text: string = '') {
    this.root = this.buildLeaf(text);
  }

  private buildLeaf(text: string): Node {
    return new Node(text, null, null);
  }

  private buildInternal(left: Node, right: Node): Node {
    return new Node(null, left, right);
  }

  /**
   * Inserts text at the specified index.
   * @param index Index to insert at.
   * @param text Text to insert.
   */
  insert(index: number, text: string): void {
    const [left, right] = this.split(this.root, index);
    const newText = new Node(text, null, null);
    this.root = this.merge(left, newText, right);
  }

  /**
   * Deletes text from start to end (exclusive).
   * @param start Start index.
   * @param end End index.
   */
  delete(start: number, end: number): void {
    const [left, middleRight] = this.split(this.root, start);
    const [middle, right] = this.split(middleRight, end - start);
    this.root = this.merge(left, middle, right);
  }

  /**
   * Gets the character at the specified index.
   * @param index Index of the character.
   * @returns The character at the index.
   */
  charAt(index: number): string {
    let node = this.root;
    while (node) {
      if (node.value !== null) {
        return node.value.charAt(index);
      }
      const leftSize = node.left ? node.left.size : 0;
      if (index < leftSize) {
        node = node.left;
      } else {
        index -= leftSize;
        node = node.right;
      }
    }
    throw new Error('Index out of bounds');
  }

  /**
   * Gets a substring from start to end (exclusive).
   * @param start Start index.
   * @param end End index.
   * @returns The substring.
   */
  substring(start: number, end: number): string {
    const [left, middleRight] = this.split(this.root, start);
    const [middle, right] = this.split(middleRight, end - start);
    return this.toString(middle);
  }

  /**
   * Converts the rope to a string.
   * @returns The full text.
   */
  toString(): string {
    return this.toString(this.root);
  }

  private toString(node: Node | null): string {
    if (!node) return '';
    if (node.value !== null) return node.value;
    return this.toString(node.left) + this.toString(node.right);
  }

  /**
   * Gets the length of the rope.
   */
  get length(): number {
    return this.root ? this.root.size : 0;
  }

  private split(node: Node | null, pos: number): [Node | null, Node | null] {
    if (!node) return [null, null];
    if (node.value !== null) {
      if (pos === 0) return [null, node];
      if (pos === node.value.length) return [node, null];
      const leftVal = node.value.slice(0, pos);
      const rightVal = node.value.slice(pos);
      return [new Node(leftVal, null, null), new Node(rightVal, null, null)];
    }
    const leftSize = node.left ? node.left.size : 0;
    if (pos <= leftSize) {
      const [leftLeft, leftRight] = this.split(node.left, pos);
      return [this.merge(leftLeft, leftRight, node.right), null];
    } else {
      const [rightLeft, rightRight] = this.split(node.right, pos - leftSize);
      return [this.merge(node.left, node.right, rightLeft), rightRight];
    }
  }

  private merge(left: Node | null, mid: Node | null, right: Node | null): Node {
    if (!mid) return left ? left : right ? right : new Node('', null, null);
    if (!left) return this.merge(mid, right, null);
    if (!right) return this.merge(left, mid, null);
    return new Node(null, left, right);
  }
}