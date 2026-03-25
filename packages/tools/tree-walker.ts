/**
 * tree-walker.ts
 * Generic tree traversal with visitor pattern, path tracking, and find/filter/map.
 * Zero external dependencies. Supports DFS (default) and BFS traversal.
 */

export type TreeNode<T> = T & { children?: TreeNode<T>[] };

export type WalkSignal = "continue" | "skip" | "stop";

export interface Visitor<T> {
  enter?: (node: TreeNode<T>, path: string[]) => WalkSignal | void;
  leave?: (node: TreeNode<T>, path: string[]) => void;
}

export interface WalkOptions {
  order?: "dfs" | "bfs";
  getKey?: <T>(node: TreeNode<T>) => string;
}

type NodeWithKey = { [key: string]: unknown; children?: NodeWithKey[] };

function defaultKey(node: NodeWithKey, index: number): string {
  const name =
    (node as { name?: string }).name ??
    (node as { id?: string | number }).id ??
    (node as { key?: string | number }).key;
  return name !== undefined ? String(name) : String(index);
}

/**
 * Walk a tree with a visitor. DFS by default, BFS optional.
 * Visitor.enter can return "skip" to skip children, or "stop" to halt traversal.
 */
export function walkTree<T extends object>(
  root: TreeNode<T>,
  visitor: Visitor<T>,
  options: WalkOptions = {}
): void {
  const { order = "dfs" } = options;

  if (order === "bfs") {
    _bfs(root, visitor, options);
  } else {
    _dfs(root, visitor, [], options);
  }
}

function _dfs<T extends object>(
  node: TreeNode<T>,
  visitor: Visitor<T>,
  path: string[],
  options: WalkOptions
): WalkSignal {
  const key = options.getKey
    ? options.getKey(node)
    : defaultKey(node as NodeWithKey, path.length);
  const currentPath = [...path, key];

  if (visitor.enter) {
    const signal = visitor.enter(node, currentPath);
    if (signal === "stop") return "stop";
    if (signal === "skip") {
      visitor.leave?.(node, currentPath);
      return "continue";
    }
  }

  const children = node.children ?? [];
  for (const child of children) {
    const result = _dfs(child as TreeNode<T>, visitor, currentPath, options);
    if (result === "stop") return "stop";
  }

  visitor.leave?.(node, currentPath);
  return "continue";
}

function _bfs<T extends object>(
  root: TreeNode<T>,
  visitor: Visitor<T>,
  options: WalkOptions
): void {
  type QueueItem = { node: TreeNode<T>; path: string[] };
  const queue: QueueItem[] = [];

  const rootKey = options.getKey
    ? options.getKey(root)
    : defaultKey(root as NodeWithKey, 0);
  queue.push({ node: root, path: [rootKey] });

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;

    if (visitor.enter) {
      const signal = visitor.enter(node, path);
      if (signal === "stop") return;
      if (signal === "skip") continue;
    }

    const children = node.children ?? [];
    children.forEach((child, i) => {
      const childKey = options.getKey
        ? options.getKey(child as TreeNode<T>)
        : defaultKey(child as NodeWithKey, i);
      queue.push({ node: child as TreeNode<T>, path: [...path, childKey] });
    });

    visitor.leave?.(node, path);
  }
}

/**
 * Find the first node matching predicate. Returns undefined if not found.
 */
export function findInTree<T extends object>(
  root: TreeNode<T>,
  predicate: (node: TreeNode<T>, path: string[]) => boolean,
  options: WalkOptions = {}
): TreeNode<T> | undefined {
  let found: TreeNode<T> | undefined;

  walkTree(root, {
    enter(node, path) {
      if (predicate(node, path)) {
        found = node;
        return "stop";
      }
    },
  }, options);

  return found;
}

/**
 * Collect all nodes matching predicate.
 */
export function filterTree<T extends object>(
  root: TreeNode<T>,
  predicate: (node: TreeNode<T>, path: string[]) => boolean,
  options: WalkOptions = {}
): TreeNode<T>[] {
  const results: TreeNode<T>[] = [];

  walkTree(root, {
    enter(node, path) {
      if (predicate(node, path)) results.push(node);
    },
  }, options);

  return results;
}

/**
 * Map over every node, returning a new tree. Children are mapped recursively.
 * The mapper receives the original node and its path; return a replacement node.
 * Children on the replacement are overwritten with mapped children - do not set them.
 */
export function mapTree<T extends object, U extends object>(
  root: TreeNode<T>,
  mapper: (node: TreeNode<T>, path: string[]) => U,
  path: string[] = [],
  options: WalkOptions = {}
): TreeNode<U> {
  const key = options.getKey
    ? options.getKey(root)
    : defaultKey(root as NodeWithKey, path.length);
  const currentPath = [...path, key];

  const mapped = mapper(root, currentPath) as TreeNode<U>;
  const children = root.children ?? [];
  const mappedChildren = children.map((child) =>
    mapTree(child as TreeNode<T>, mapper, currentPath, options)
  );

  return { ...mapped, children: mappedChildren.length > 0 ? mappedChildren : undefined };
}
