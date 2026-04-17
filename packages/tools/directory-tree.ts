/**
 * Represents a node in the directory tree.
 */
export interface DirNode {
  name: string;
  path: string;
  children?: DirNode[];
}

/**
 * Builds a tree from an array of path strings.
 * @param paths - Array of directory paths.
 * @returns Root DirNode representing the tree.
 */
export function fromPaths(paths: string[]): DirNode {
  const root: DirNode = { name: '', path: '', children: [] };
  for (const path of paths) {
    if (path === '') continue;
    const parts = path.split('/').filter(p => p !== '');
    let current = root;
    for (const part of parts) {
      let child = current.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, path: current.path + '/' + part, children: [] };
        current.children.push(child);
      }
      current = child;
    }
  }
  return root;
}

/**
 * Renders a DirNode tree as ASCII text.
 * @param tree - Root DirNode of the tree.
 * @param indent - Current indentation level (default 0).
 * @returns ASCII tree representation.
 */
export function toText(tree: DirNode, indent: number = 0): string {
  let result = '';
  for (const child of tree.children) {
    result += ' '.repeat(indent) + child.name + '\n';
    result += toText(child, indent + 2);
  }
  return result;
}

/**
 * Finds a node in the tree by exact path match.
 * @param tree - Root DirNode of the tree.
 * @param path - Path to search for.
 * @returns Matching DirNode or null.
 */
export function findNode(tree: DirNode, path: string): DirNode | null {
  if (tree.path === path) {
    return tree;
  }
  for (const child of tree.children) {
    const found = findNode(child, path);
    if (found) {
      return found;
    }
  }
  return null;
}