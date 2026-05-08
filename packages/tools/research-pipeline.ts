import * as fs from 'fs';

/**
 * Represents a research source with a URL and content.
 */
interface Source {
  url: string;
  content: string;
}

/**
 * Tracks provenance information for each stage.
 */
interface Provenance {
  consulted: Source[];
  accepted: Source[];
  rejected: Source[];
}

/**
 * Represents the state of a pipeline stage.
 */
interface StageState {
  sources: Source[];
  provenance: Provenance;
  auditResults?: { severity: 'FATAL' | 'MAJOR' | 'MINOR'; message: string }[];
}

/**
 * Pipeline orchestrator for adversarial research.
 */
interface PipelineOrchestrator {
  run(): void;
}

/**
 * Creates a new adversarial research pipeline for the given topic.
 * @param topic The research topic.
 * @returns A pipeline orchestrator.
 */
export function createResearchPipeline(topic: string): PipelineOrchestrator {
  const baseDir = `pipeline/${topic}/`;
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  return {
    run: () => {
      const researchState = researchStage(baseDir);
      fs.writeFileSync(`${baseDir}research.json`, JSON.stringify(researchState, null, 2));

      const writeState = writeStage(baseDir);
      fs.writeFileSync(`${baseDir}draft.json`, JSON.stringify(writeState, null, 2));

      const verifyState = verifyStage(baseDir);
      fs.writeFileSync(`${baseDir}verified.json`, JSON.stringify(verifyState, null, 2));

      const reviewState = reviewStage(baseDir);
      fs.writeFileSync(`${baseDir}audit.json`, JSON.stringify(reviewState, null, 2));
    }
  };
}

/**
 * Simulates the research stage: gathers sources with URLs.
 * @param baseDir Base directory for pipeline files.
 * @returns The state after the research stage.
 */
function researchStage(baseDir: string): StageState {
  const sources: Source[] = [
    { url: 'https://example.com/1', content: 'Sample content 1' },
    { url: 'https://example.com/2', content: 'Sample content 2' }
  ];
  const provenance: Provenance = {
    consulted: sources,
    accepted: sources,
    rejected: []
  };
  return { sources, provenance };
}

/**
 * Simulates the write stage: drafts content from sources.
 * @param baseDir Base directory for pipeline files.
 * @returns The state after the write stage.
 */
function writeStage(baseDir: string): StageState {
  const prevState = JSON.parse(fs.readFileSync(`${baseDir}research.json`, 'utf-8')) as StageState;
  const provenance: Provenance = {
    consulted: prevState.provenance.consulted,
    accepted: prevState.provenance.accepted,
    rejected: prevState.provenance.rejected
  };
  return { sources: [], provenance };
}

/**
 * Simulates the verify stage: checks URLs and filters unverifiable claims.
 * @param baseDir Base directory for pipeline files.
 * @returns The state after the verify stage.
 */
function verifyStage(baseDir: string): StageState {
  const prevState = JSON.parse(fs.readFileSync(`${baseDir}research.json`, 'utf-8')) as StageState;
  const verifiedSources = prevState.sources.filter(s => isValidURL(s.url));
  const rejectedSources = prevState.sources.filter(s => !isValidURL(s.url));
  const provenance: Provenance = {
    consulted: prevState.provenance.consulted,
    accepted: verifiedSources,
    rejected: rejectedSources
  };
  return { sources: verifiedSources, provenance };
}

/**
 * Simulates the review stage: adversarial audit with severity levels.
 * @param baseDir Base directory for pipeline files.
 * @returns The state after the review stage.
 */
function reviewStage(baseDir: string): StageState {
  const prevState = JSON.parse(fs.readFileSync(`${baseDir}verified.json`, 'utf-8')) as StageState;
  const auditResults = [
    { severity: 'FATAL', message: 'Critical error in content' },
    { severity: 'MAJOR', message: 'Major inconsistency found' },
    { severity: 'MINOR', message: 'Minor typo detected' }
  ];
  const provenance: Provenance = {
    consulted: prevState.provenance.consulted,
    accepted: prevState.provenance.accepted,
    rejected: prevState.provenance.rejected
  };
  return { sources: [], provenance, auditResults };
}

/**
 * Validates if a URL is well-formed.
 * @param url The URL to validate.
 * @returns True if the URL is valid.
 */
function isValidURL(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}