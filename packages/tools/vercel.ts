/**
 * 8gent Code - Vercel Deployment Management Tools
 *
 * Pure REST API integration with Vercel. No external deps, just fetch.
 * Covers projects, deployments, env vars, domains, and logs.
 */

const VERCEL_API = "https://api.vercel.com";

function getToken(): string | null {
  return process.env.VERCEL_TOKEN || null;
}

async function vercelFetch(path: string, opts?: RequestInit): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error("VERCEL_TOKEN not set. Run: export VERCEL_TOKEN=your_token");
  return fetch(`${VERCEL_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
}

// ============================================
// API Functions
// ============================================

export async function vercelListProjects(): Promise<string> {
  const res = await vercelFetch("/v9/projects?limit=20");
  if (!res.ok) return `Vercel API error ${res.status}: ${await res.text()}`;
  const data = await res.json() as { projects: Array<{ id: string; name: string; framework: string | null; updatedAt: number }> };
  const projects = data.projects.map((p) => ({
    id: p.id,
    name: p.name,
    framework: p.framework || "unknown",
    updated: new Date(p.updatedAt).toISOString(),
  }));
  return JSON.stringify({ count: projects.length, projects }, null, 2);
}

export async function vercelGetDeployments(projectId: string, limit = 5): Promise<string> {
  const res = await vercelFetch(`/v6/deployments?projectId=${projectId}&limit=${limit}`);
  if (!res.ok) return `Vercel API error ${res.status}: ${await res.text()}`;
  const data = await res.json() as { deployments: Array<{ uid: string; name: string; state: string; url: string; created: number; meta?: { githubCommitMessage?: string } }> };
  const deploys = data.deployments.map((d) => ({
    id: d.uid,
    name: d.name,
    state: d.state,
    url: d.url ? `https://${d.url}` : null,
    created: new Date(d.created).toISOString(),
    commitMessage: d.meta?.githubCommitMessage || null,
  }));
  return JSON.stringify({ count: deploys.length, deployments: deploys }, null, 2);
}

export async function vercelDeploy(projectId: string): Promise<string> {
  // Trigger a redeployment by creating a new deployment from the latest
  // First get the latest deployment to reuse its config
  const listRes = await vercelFetch(`/v6/deployments?projectId=${projectId}&limit=1`);
  if (!listRes.ok) return `Failed to fetch latest deployment: ${await listRes.text()}`;
  const listData = await listRes.json() as { deployments: Array<{ uid: string; name: string; target: string | null }> };

  if (listData.deployments.length === 0) {
    return "No existing deployments found. Push to git to trigger the first deploy.";
  }

  const latest = listData.deployments[0];
  // Redeploy by creating from the latest deployment
  const res = await vercelFetch("/v13/deployments", {
    method: "POST",
    body: JSON.stringify({
      name: latest.name,
      deploymentId: latest.uid,
      target: latest.target || "production",
    }),
  });

  if (!res.ok) return `Deploy failed (${res.status}): ${await res.text()}`;
  const deploy = await res.json() as { id: string; url: string; readyState: string };
  return JSON.stringify({
    status: "triggered",
    id: deploy.id,
    url: deploy.url ? `https://${deploy.url}` : null,
    state: deploy.readyState,
  }, null, 2);
}

export async function vercelSetEnv(
  projectId: string,
  key: string,
  value: string,
  target: string[] = ["production", "preview", "development"]
): Promise<string> {
  const res = await vercelFetch(`/v10/projects/${projectId}/env`, {
    method: "POST",
    body: JSON.stringify({ key, value, target, type: "encrypted" }),
  });
  if (!res.ok) return `Set env failed (${res.status}): ${await res.text()}`;
  const env = await res.json() as { key: string; target: string[] };
  return JSON.stringify({ status: "created", key: env.key, target: env.target }, null, 2);
}

export async function vercelGetEnv(projectId: string): Promise<string> {
  const res = await vercelFetch(`/v9/projects/${projectId}/env`);
  if (!res.ok) return `Get env failed (${res.status}): ${await res.text()}`;
  const data = await res.json() as { envs: Array<{ key: string; target: string[]; type: string; updatedAt: number }> };
  const envs = data.envs.map((e) => ({
    key: e.key,
    target: e.target,
    type: e.type,
    updated: new Date(e.updatedAt).toISOString(),
  }));
  return JSON.stringify({ count: envs.length, envs }, null, 2);
}

export async function vercelListDomains(projectId: string): Promise<string> {
  const res = await vercelFetch(`/v9/projects/${projectId}/domains`);
  if (!res.ok) return `List domains failed (${res.status}): ${await res.text()}`;
  const data = await res.json() as { domains: Array<{ name: string; verified: boolean; redirect: string | null }> };
  const domains = data.domains.map((d) => ({
    name: d.name,
    verified: d.verified,
    redirect: d.redirect,
  }));
  return JSON.stringify({ count: domains.length, domains }, null, 2);
}

export async function vercelGetDeploymentLogs(deploymentId: string): Promise<string> {
  const res = await vercelFetch(`/v2/deployments/${deploymentId}/events`);
  if (!res.ok) return `Get logs failed (${res.status}): ${await res.text()}`;
  const events = await res.json() as Array<{ type: string; created: number; text?: string; payload?: { text?: string } }>;
  // Take last 50 log entries to keep output manageable
  const recent = (Array.isArray(events) ? events : []).slice(-50);
  const logs = recent.map((e) => ({
    type: e.type,
    time: new Date(e.created).toISOString(),
    text: e.text || e.payload?.text || "",
  }));
  return JSON.stringify({ count: logs.length, logs }, null, 2);
}

/**
 * Auto-detect project ID from git remote URL.
 * Matches Vercel project names to GitHub repo names.
 */
export async function vercelDetectProject(): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const remote = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
    // Extract repo name from git URL (github.com/org/repo-name.git -> repo-name)
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    if (!match) return null;
    const repoName = match[1];

    // Search projects by name
    const res = await vercelFetch(`/v9/projects?search=${repoName}&limit=5`);
    if (!res.ok) return null;
    const data = await res.json() as { projects: Array<{ id: string; name: string }> };
    // Return first matching project
    const project = data.projects.find((p) => p.name === repoName) || data.projects[0];
    return project?.id || null;
  } catch {
    return null;
  }
}
