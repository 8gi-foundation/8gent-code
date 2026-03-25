/**
 * tree-printer.ts
 * Prints tree data structures as indented text with connectors.
 * Supports ASCII and Unicode styles, async child resolvers, and depth limits.
 */

export type TreeStyle = "ascii" | "unicode";

export interface TreeOptions {
  style?: TreeStyle;
  maxDepth?: number;
  indent?: number;
}

interface StyleSet {
  branch: string;
  last: string;
  vertical: string;
  empty: string;
}

const STYLES: Record<TreeStyle, StyleSet> = {
  unicode: {
    branch: "├── ",
    last: "└── ",
    vertical: "│   ",
    empty: "    ",
  },
  ascii: {
    branch: "|-- ",
    last: "`-- ",
    vertical: "|   ",
    empty: "    ",
  },
};

/**
 * Prints a single tree rooted at `root`.
 *
 * @param root        - The root node of the tree.
 * @param getChildren - Returns (or resolves to) the children of a node.
 * @param getLabel    - Returns the display label for a node.
 * @param options     - Style, depth limit, and indent width.
 * @returns           - Formatted tree string.
 */
export async function printTree<T>(
  root: T,
  getChildren: (node: T) => T[] | Promise<T[]>,
  getLabel: (node: T) => string,
  options: TreeOptions = {}
): Promise<string> {
  const { style = "unicode", maxDepth = Infinity } = options;
  const connectors = STYLES[style];
  const lines: string[] = [];

  lines.push(getLabel(root));

  await walk(root, "", 0);

  return lines.join("\n");

  async function walk(node: T, prefix: string, depth: number): Promise<void> {
    if (depth >= maxDepth) return;

    const children = await Promise.resolve(getChildren(node));
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      const connector = isLast ? connectors.last : connectors.branch;
      const childPrefix = prefix + (isLast ? connectors.empty : connectors.vertical);

      lines.push(prefix + connector + getLabel(child));
      await walk(child, childPrefix, depth + 1);
    }
  }
}

/**
 * Prints a forest (multiple root nodes) as a single string.
 *
 * @param roots       - Array of root nodes.
 * @param getChildren - Returns (or resolves to) the children of a node.
 * @param getLabel    - Returns the display label for a node.
 * @param options     - Style, depth limit, and indent width.
 * @returns           - Formatted forest string with blank lines between trees.
 */
export async function printForest<T>(
  roots: T[],
  getChildren: (node: T) => T[] | Promise<T[]>,
  getLabel: (node: T) => string,
  options: TreeOptions = {}
): Promise<string> {
  const trees: string[] = [];
  for (const root of roots) {
    trees.push(await printTree(root, getChildren, getLabel, options));
  }
  return trees.join("\n\n");
}

// --- Example (run directly with: bun packages/tools/tree-printer.ts) ---

if (import.meta.main) {
  interface Node {
    name: string;
    children?: Node[];
  }

  const tree: Node = {
    name: "root",
    children: [
      {
        name: "src",
        children: [
          { name: "index.ts" },
          { name: "utils.ts" },
          { name: "components", children: [{ name: "Button.tsx" }, { name: "Input.tsx" }] },
        ],
      },
      { name: "package.json" },
      { name: "tsconfig.json" },
    ],
  };

  const result = await printTree(
    tree,
    (n) => n.children ?? [],
    (n) => n.name,
    { style: "unicode" }
  );

  console.log("Unicode style:\n");
  console.log(result);

  const ascii = await printTree(
    tree,
    (n) => n.children ?? [],
    (n) => n.name,
    { style: "ascii" }
  );

  console.log("\nASCII style:\n");
  console.log(ascii);
}
