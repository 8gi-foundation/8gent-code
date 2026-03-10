/**
 * 8gent Code - Core Type Definitions
 */

// ============================================
// Tool System
// ============================================

export type Permission =
  | "read:code"
  | "write:code"
  | "read:fs"
  | "write:fs"
  | "exec:shell"
  | "net:fetch"
  | "net:listen"
  | "github:read"
  | "github:write";

export type Capability =
  | "code"
  | "code.symbol"
  | "code.ast"
  | "design"
  | "design.component"
  | "design.animation"
  | "workflow"
  | "repo"
  | "repo.graph"
  | "github"
  | "execution";

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
}

export interface Tool {
  name: string;
  description: string;
  capabilities: Capability[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  permissions: Permission[];
  execute: (input: unknown, context: ExecutionContext) => Promise<unknown>;
}

export interface ToolRegistration {
  name: string;
  description: string;
  capabilities: Capability[];
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  permissions: Permission[];
}

// ============================================
// Execution Context
// ============================================

export interface ExecutionContext {
  sessionId: string;
  workingDirectory: string;
  permissions: Permission[];
  sandbox: SandboxConfig;
}

export interface SandboxConfig {
  type: "container" | "runtime" | "none";
  allowedPaths: string[];
  networkAccess: boolean;
  timeout: number;
}

// ============================================
// AST Index
// ============================================

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "interface"
  | "constant"
  | "variable"
  | "module";

export interface Symbol {
  id: string;           // e.g., "src/utils/index.ts::parseDate"
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  summary?: string;
}

export interface FileOutline {
  filePath: string;
  language: string;
  symbols: Symbol[];
}

export interface RepoIndex {
  id: string;
  sourceRoot: string;
  indexedAt: string;
  fileCount: number;
  symbolCount: number;
  languages: Record<string, number>;
}

// ============================================
// Planner
// ============================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  dependencies: string[];
  blockedBy: string[];
  output?: unknown;
}

export interface Plan {
  id: string;
  goal: string;
  tasks: Task[];
  createdAt: string;
  status: "planning" | "executing" | "completed" | "failed";
}

// ============================================
// Workflow
// ============================================

export interface WorkflowStep {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  condition?: string;
  onSuccess?: string;
  onFailure?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger: "manual" | "event" | "schedule";
  steps: WorkflowStep[];
}

// ============================================
// Primitives
// ============================================

export interface Primitive {
  id: string;
  type: "component" | "animation" | "workflow" | "schema";
  name: string;
  description: string;
  source: string;      // File path or URL
  tags: string[];
  usage: string;       // Example usage
}

export interface PrimitiveRegistry {
  primitives: Primitive[];
  version: string;
  lastUpdated: string;
}

// ============================================
// GitHub Intelligence
// ============================================

export interface GitHubSymbol extends Symbol {
  repo: string;
  stars: number;
  lastCommit: string;
}

export interface GitHubQuery {
  query: string;
  language?: string;
  minStars?: number;
  limit?: number;
}

export interface DependencyGraph {
  root: string;
  dependencies: Record<string, string[]>;
  devDependencies: Record<string, string[]>;
}
