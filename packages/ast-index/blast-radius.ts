/**
 * Blast-Radius Engine — code-review-graph pattern
 *
 * Builds a graph of code relationships:
 * - Nodes: functions, classes, types, exports
 * - Edges: calls, imports, implements, tests-cover
 *
 * Query: "If I change function X, what is affected?"
 * → Returns callers, tests, interfaces, estimated impact level
 */

import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";
import * as os from "os";

interface CodeNode {
  id: string; // file::symbolName
  file: string;
  name: string;
  type:
    | "function"
    | "class"
    | "method"
    | "type"
    | "interface"
    | "variable"
    | "export";
  startLine: number;
  endLine: number;
  signature?: string;
}

interface CodeEdge {
  from: string; // node id
  to: string; // node id
  type: "calls" | "imports" | "implements" | "tests" | "extends" | "uses_type";
}

interface BlastRadius {
  target: CodeNode;
  directCallers: CodeNode[];
  transitiveCallers: CodeNode[]; // callers of callers (depth 2)
  tests: CodeNode[];
  interfaces: CodeNode[]; // types/interfaces that constrain this
  dependents: CodeNode[]; // files that import this file
  estimatedImpact: "low" | "medium" | "high" | "critical";
  affectedFiles: string[];
  suggestedContext: string[]; // minimal file set to include in prompt
}

export class BlastRadiusEngine {
  private db: Database;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
    const dbPath = join(os.homedir(), ".8gent", "blast-radius.db");
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        signature TEXT,
        indexed_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    `);
  }

  /** Index a TypeScript/JavaScript file into the graph */
  indexFile(filePath: string): number {
    const absPath = join(this.projectRoot, filePath);
    if (!existsSync(absPath)) return 0;
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");

    // Clear old data for this file
    const deleteNodes = this.db.prepare("DELETE FROM nodes WHERE file = ?");
    const deleteEdgesFrom = this.db.prepare(
      "DELETE FROM edges WHERE from_id LIKE ?"
    );
    const deleteEdgesTo = this.db.prepare(
      "DELETE FROM edges WHERE to_id LIKE ?"
    );
    deleteNodes.run(filePath);
    deleteEdgesFrom.run(`${filePath}::%`);
    deleteEdgesTo.run(`${filePath}::%`);

    let nodesAdded = 0;
    const insertNode = this.db.prepare(
      "INSERT OR REPLACE INTO nodes (id, file, name, type, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const insertEdge = this.db.prepare(
      "INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, ?)"
    );

    // Parse functions, classes, types using regex (lightweight, no tree-sitter dep)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Function declarations
      let match = line.match(
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/
      );
      if (match) {
        const id = `${filePath}::${match[1]}`;
        const endLine = this.findBlockEnd(lines, i);
        insertNode.run(
          id,
          filePath,
          match[1],
          "function",
          i + 1,
          endLine,
          line.trim()
        );
        nodesAdded++;
      }

      // Arrow functions / const functions
      match = line.match(
        /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/
      );
      if (match) {
        const id = `${filePath}::${match[1]}`;
        const endLine = this.findBlockEnd(lines, i);
        insertNode.run(
          id,
          filePath,
          match[1],
          "function",
          i + 1,
          endLine,
          line.trim()
        );
        nodesAdded++;
      }

      // Classes
      match = line.match(
        /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(\w+))?/
      );
      if (match) {
        const id = `${filePath}::${match[1]}`;
        const endLine = this.findBlockEnd(lines, i);
        insertNode.run(
          id,
          filePath,
          match[1],
          "class",
          i + 1,
          endLine,
          line.trim()
        );
        nodesAdded++;
        if (match[2]) insertEdge.run(id, `*::${match[2]}`, "extends");
        if (match[3]) insertEdge.run(id, `*::${match[3]}`, "implements");
      }

      // Interfaces and types
      match = line.match(/(?:export\s+)?(?:interface|type)\s+(\w+)/);
      if (match) {
        const id = `${filePath}::${match[1]}`;
        insertNode.run(
          id,
          filePath,
          match[1],
          "interface",
          i + 1,
          i + 1,
          line.trim()
        );
        nodesAdded++;
      }

      // Imports (create edges)
      match = line.match(
        /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/
      );
      if (match) {
        const imports = match[1]
          .split(",")
          .map((s) => s.trim().split(" as ")[0].trim());
        const fromPath = this.resolveImportPath(filePath, match[2]);
        for (const imp of imports) {
          insertEdge.run(`${filePath}::*`, `${fromPath}::${imp}`, "imports");
        }
      }
    }

    // Detect function calls within the file (simple heuristic)
    const nodeNames = this.db
      .prepare("SELECT id, name FROM nodes WHERE file = ?")
      .all(filePath) as any[];
    for (let i = 0; i < lines.length; i++) {
      for (const node of nodeNames) {
        // Check if this line calls another known function
        const callPattern = new RegExp(`\\b${node.name}\\s*\\(`);
        if (callPattern.test(lines[i])) {
          // Find which function this line belongs to
          const container = this.findContainingNode(filePath, i + 1);
          if (container && container !== node.id) {
            insertEdge.run(container, node.id, "calls");
          }
        }
      }
    }

    // Detect test files covering this file
    if (filePath.includes(".test.") || filePath.includes(".spec.")) {
      const testedFile = filePath
        .replace(/\.test\./, ".")
        .replace(/\.spec\./, ".");
      const testedNodes = this.db
        .prepare("SELECT id FROM nodes WHERE file = ?")
        .all(testedFile) as any[];
      for (const tn of testedNodes) {
        insertEdge.run(`${filePath}::*`, tn.id, "tests");
      }
    }

    return nodesAdded;
  }

  /** Index all TS/JS files in a directory */
  indexDirectory(
    dir?: string,
    exclude?: string[]
  ): { files: number; nodes: number } {
    const root = dir || this.projectRoot;
    const defaultExclude = [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      ".8gent",
    ];
    const excludeSet = new Set([...defaultExclude, ...(exclude || [])]);
    let files = 0,
      nodes = 0;

    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        if (excludeSet.has(entry)) continue;
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        if (![".ts", ".tsx", ".js", ".jsx"].includes(extname(entry))) continue;
        const rel = relative(this.projectRoot, full);
        nodes += this.indexFile(rel);
        files++;
      }
    };

    walk(root);
    return { files, nodes };
  }

  /** Get the blast radius of changing a symbol */
  getBlastRadius(file: string, symbolName: string): BlastRadius {
    // Find the target node
    const targetId = `${file}::${symbolName}`;
    const target = this.db
      .prepare(
        "SELECT * FROM nodes WHERE id = ? OR (file = ? AND name = ?)"
      )
      .get(targetId, file, symbolName) as any;

    if (!target) {
      // Try fuzzy match
      const fuzzy = this.db
        .prepare("SELECT * FROM nodes WHERE name = ?")
        .get(symbolName) as any;
      if (!fuzzy)
        throw new Error(`Symbol not found: ${symbolName} in ${file}`);
      return this.getBlastRadius(fuzzy.file, fuzzy.name);
    }

    // Direct callers
    const directCallers = this.db
      .prepare(
        `SELECT n.* FROM nodes n JOIN edges e ON n.id = e.from_id
       WHERE e.to_id = ? AND e.type = 'calls'`
      )
      .all(target.id) as CodeNode[];

    // Transitive callers (depth 2)
    const transitiveCallers = this.db
      .prepare(
        `SELECT DISTINCT n.* FROM nodes n JOIN edges e ON n.id = e.from_id
       WHERE e.to_id IN (SELECT from_id FROM edges WHERE to_id = ? AND type = 'calls')
       AND e.type = 'calls' AND n.id != ?`
      )
      .all(target.id, target.id) as CodeNode[];

    // Tests
    const tests = this.db
      .prepare(
        `SELECT n.* FROM nodes n JOIN edges e ON n.id = e.from_id
       WHERE e.to_id = ? AND e.type = 'tests'`
      )
      .all(target.id) as CodeNode[];

    // Interfaces that constrain this
    const interfaces = this.db
      .prepare(
        `SELECT n.* FROM nodes n JOIN edges e ON n.id = e.to_id
       WHERE e.from_id = ? AND e.type IN ('implements', 'uses_type')`
      )
      .all(target.id) as CodeNode[];

    // Files that import from this file
    const dependents = this.db
      .prepare(
        `SELECT DISTINCT n.* FROM nodes n JOIN edges e ON n.id = e.from_id
       WHERE e.to_id LIKE ? AND e.type = 'imports'`
      )
      .all(`${file}::%`) as CodeNode[];

    // Collect affected files
    const affectedFiles = [
      ...new Set([
        target.file,
        ...directCallers.map((n: CodeNode) => n.file),
        ...tests.map((n: CodeNode) => n.file),
        ...dependents.map((n: CodeNode) => n.file),
      ]),
    ];

    // Estimate impact
    const totalAffected =
      directCallers.length + transitiveCallers.length + dependents.length;
    const estimatedImpact: BlastRadius["estimatedImpact"] =
      totalAffected >= 20
        ? "critical"
        : totalAffected >= 10
          ? "high"
          : totalAffected >= 3
            ? "medium"
            : "low";

    return {
      target: target as CodeNode,
      directCallers,
      transitiveCallers,
      tests,
      interfaces,
      dependents,
      estimatedImpact,
      affectedFiles,
      suggestedContext: affectedFiles.slice(0, 10), // top 10 files for prompt
    };
  }

  /** Format blast radius for prompt injection */
  formatForPrompt(br: BlastRadius): string {
    let ctx = `## Blast Radius: ${br.target.name} (${br.target.file})\n`;
    ctx += `Impact: ${br.estimatedImpact.toUpperCase()} (${br.affectedFiles.length} files)\n`;
    if (br.directCallers.length > 0)
      ctx += `Callers: ${br.directCallers.map((n) => `${n.file}::${n.name}`).join(", ")}\n`;
    if (br.tests.length > 0)
      ctx += `Tests: ${br.tests.map((n) => n.file).join(", ")}\n`;
    if (br.interfaces.length > 0)
      ctx += `Constrained by: ${br.interfaces.map((n) => n.name).join(", ")}\n`;
    return ctx;
  }

  /** Get graph stats */
  getStats(): { nodes: number; edges: number; files: number } {
    const nodes = (
      this.db.prepare("SELECT COUNT(*) as c FROM nodes").get() as any
    ).c;
    const edges = (
      this.db.prepare("SELECT COUNT(*) as c FROM edges").get() as any
    ).c;
    const files = (
      this.db
        .prepare("SELECT COUNT(DISTINCT file) as c FROM nodes")
        .get() as any
    ).c;
    return { nodes, edges, files };
  }

  /** Close the database connection */
  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  private findBlockEnd(lines: string[], startLine: number): number {
    let depth = 0;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        if (ch === "}") {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
    }
    return startLine + 1;
  }

  private findContainingNode(file: string, line: number): string | null {
    const node = this.db
      .prepare(
        "SELECT id FROM nodes WHERE file = ? AND start_line <= ? AND end_line >= ? ORDER BY (end_line - start_line) ASC LIMIT 1"
      )
      .get(file, line, line) as any;
    return node?.id || null;
  }

  private resolveImportPath(fromFile: string, importPath: string): string {
    if (importPath.startsWith(".")) {
      const dir = fromFile.split("/").slice(0, -1).join("/");
      let resolved = join(dir, importPath).replace(/\\/g, "/");
      if (!resolved.includes(".")) resolved += ".ts";
      return resolved;
    }
    return importPath;
  }
}
