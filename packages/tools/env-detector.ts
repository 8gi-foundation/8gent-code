/**
 * Runtime Environment Detector
 * Detects CI provider, container status, OS details, shell type, and terminal capabilities.
 */

export interface EnvProfile {
  ci: CIProfile;
  container: ContainerProfile;
  os: OSProfile;
  shell: ShellProfile;
  terminal: TerminalProfile;
  tty: boolean;
}

export interface CIProfile {
  isCI: boolean;
  provider: string | null;
  buildId: string | null;
  branch: string | null;
  commit: string | null;
}

export interface ContainerProfile {
  isDocker: boolean;
  isKubernetes: boolean;
  isContainer: boolean;
  containerRuntime: string | null;
}

export interface OSProfile {
  platform: string;
  arch: string;
  release: string | null;
  hostname: string | null;
}

export interface ShellProfile {
  shell: string | null;
  shellVersion: string | null;
  path: string | null;
}

export interface TerminalProfile {
  term: string | null;
  termProgram: string | null;
  colorDepth: number;
  hasColor: boolean;
  columns: number | null;
  rows: number | null;
}

function detectCI(): CIProfile {
  const env = process.env;
  let provider: string | null = null;
  let buildId: string | null = null;
  let branch: string | null = null;
  let commit: string | null = null;

  if (env.GITHUB_ACTIONS) {
    provider = "github-actions";
    buildId = env.GITHUB_RUN_ID ?? null;
    branch = env.GITHUB_REF_NAME ?? null;
    commit = env.GITHUB_SHA ?? null;
  } else if (env.GITLAB_CI) {
    provider = "gitlab-ci";
    buildId = env.CI_JOB_ID ?? null;
    branch = env.CI_COMMIT_REF_NAME ?? null;
    commit = env.CI_COMMIT_SHA ?? null;
  } else if (env.JENKINS_URL || env.BUILD_ID) {
    provider = "jenkins";
    buildId = env.BUILD_ID ?? null;
    branch = env.GIT_BRANCH ?? null;
    commit = env.GIT_COMMIT ?? null;
  } else if (env.CIRCLECI) {
    provider = "circleci";
    buildId = env.CIRCLE_BUILD_NUM ?? null;
    branch = env.CIRCLE_BRANCH ?? null;
    commit = env.CIRCLE_SHA1 ?? null;
  } else if (env.TRAVIS) {
    provider = "travis-ci";
    buildId = env.TRAVIS_BUILD_ID ?? null;
    branch = env.TRAVIS_BRANCH ?? null;
    commit = env.TRAVIS_COMMIT ?? null;
  } else if (env.BUILDKITE) {
    provider = "buildkite";
    buildId = env.BUILDKITE_BUILD_ID ?? null;
    branch = env.BUILDKITE_BRANCH ?? null;
    commit = env.BUILDKITE_COMMIT ?? null;
  } else if (env.CI) {
    provider = "unknown-ci";
  }

  return {
    isCI: !!(env.CI || env.CONTINUOUS_INTEGRATION || provider),
    provider,
    buildId,
    branch,
    commit,
  };
}

function detectContainer(): ContainerProfile {
  const env = process.env;
  const isKubernetes = !!(env.KUBERNETES_SERVICE_HOST || env.KUBERNETES_PORT);
  let isDocker = false;
  let containerRuntime: string | null = null;

  // Check for /.dockerenv (reliable Docker signal)
  try {
    const { existsSync } = require("fs");
    isDocker = existsSync("/.dockerenv");
  } catch {
    // fs not available - skip
  }

  if (isDocker) containerRuntime = "docker";
  else if (isKubernetes) containerRuntime = "kubernetes";
  else if (env.container) containerRuntime = env.container;

  const isContainer = isDocker || isKubernetes || !!env.container;

  return { isDocker, isKubernetes, isContainer, containerRuntime };
}

function detectOS(): OSProfile {
  return {
    platform: process.platform,
    arch: process.arch,
    release: process.version ?? null,
    hostname: process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? null,
  };
}

function detectShell(): ShellProfile {
  const env = process.env;
  const shellPath = env.SHELL ?? env.ComSpec ?? null;
  let shell: string | null = null;

  if (shellPath) {
    const parts = shellPath.split("/");
    shell = parts[parts.length - 1] ?? null;
  } else if (process.platform === "win32") {
    shell = "cmd";
  }

  return {
    shell,
    shellVersion: env[`${shell?.toUpperCase()}_VERSION`] ?? null,
    path: shellPath,
  };
}

function detectTerminal(): TerminalProfile {
  const env = process.env;
  const term = env.TERM ?? null;
  const termProgram = env.TERM_PROGRAM ?? null;
  const colorTerm = env.COLORTERM;

  let colorDepth = 1;
  if (colorTerm === "truecolor" || colorTerm === "24bit") colorDepth = 16777216;
  else if (colorTerm === "256color" || term?.includes("256color")) colorDepth = 256;
  else if (term && term !== "dumb") colorDepth = 16;

  return {
    term,
    termProgram,
    colorDepth,
    hasColor: colorDepth > 1,
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  };
}

export function detectEnv(): EnvProfile {
  return {
    ci: detectCI(),
    container: detectContainer(),
    os: detectOS(),
    shell: detectShell(),
    terminal: detectTerminal(),
    tty: process.stdout.isTTY === true,
  };
}
