# directory-tree

Build a tree representation of a directory listing.

## Requirements
- DirNode: {name, path, children?: DirNode[]}
- fromPaths(paths[]) builds tree from path strings
- toText(tree, indent?) renders as ASCII tree
- findNode(tree, path) returns matching node or null
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/directory-tree.ts`
