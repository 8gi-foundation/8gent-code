/**
 * 8gent Auto-Research Types
 *
 * Type definitions for the autonomous research loop.
 * Inspired by: https://github.com/karpathy/autoresearch
 */

export interface ResearchOptions {
  /** Research depth: 1 = single pass, 3 = deep dive, 5 = exhaustive. Default: 2 */
  depth?: number;
  /** Max sources to fetch per query. Default: 10 */
  maxSources?: number;
  /** Specific areas to focus on, e.g. ["implementation", "architecture"] */
  focusAreas?: string[];
  /** Output format. Default: "summary" */
  outputFormat?: "summary" | "detailed" | "patterns";
  /** Ollama model for synthesis. Default: "llama3.2:latest" */
  model?: string;
}

export interface ResearchSource {
  url: string;
  title: string;
  snippet: string;
  /** 0.0-1.0 relevance score assigned during extraction */
  relevance: number;
  /** Raw text extracted from the page (truncated to 2000 chars) */
  extractedText?: string;
}

export interface ResearchPattern {
  name: string;
  description: string;
  example?: string;
}

export interface ResearchReport {
  topic: string;
  sources: ResearchSource[];
  keyFindings: string[];
  patterns: ResearchPattern[];
  recommendations: string[];
  furtherQuestions: string[];
  /** All search queries that were run */
  searchQueries: string[];
  /** Total wall-clock duration in ms */
  duration: number;
}

export interface ResearchIteration {
  queries: string[];
  sources: ResearchSource[];
  rawFindings: string[];
}
