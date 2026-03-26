/**
 * Job description interface
 */
interface JobDescription {
  title: string;
  level: string;
  team: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
}

/**
 * Builds a structured job description object
 * @param params - Job description parameters
 * @returns JobDescription object
 */
function buildJD(params: {
  title: string;
  level: string;
  team: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
}): JobDescription {
  return {
    title: params.title,
    level: params.level,
    team: params.team,
    summary: params.summary,
    responsibilities: params.responsibilities,
    requirements: params.requirements,
    benefits: params.benefits,
  };
}

/**
 * Renders job description as markdown
 * @param jd - JobDescription object
 * @returns Formatted markdown string
 */
function renderMarkdown(jd: JobDescription): string {
  return `# ${jd.title} (${jd.level})\n\n**Team:** ${jd.team}\n\n## Summary\n\n${jd.summary}\n\n## Responsibilities\n\n- ${jd.responsibilities.join('\n- ')}\n\n## Requirements\n\n- ${jd.requirements.join('\n- ')}\n\n## Benefits\n\n- ${jd.benefits.join('\n- ')}`;
}

/**
 * Checks for exclusionary language in job description
 * @param jd - JobDescription object
 * @returns Array of issue objects
 */
function scoreInclusion(jd: JobDescription): { message: string; text: string }[] {
  const issues: { message: string; text: string }[] = [];
  const forbidden = ['must be', 'he', 'she', 'male', 'female'];
  forbidden.forEach(term => {
    if (jd.summary.includes(term)) issues.push({ message: `Found exclusionary term: ${term}`, text: jd.summary });
    jd.responsibilities.forEach((r, i) => {
      if (r.includes(term)) issues.push({ message: `Found exclusionary term: ${term} in responsibility ${i + 1}`, text: r });
    });
    jd.requirements.forEach((r, i) => {
      if (r.includes(term)) issues.push({ message: `Found exclusionary term: ${term} in requirement ${i + 1}`, text: r });
    });
    jd.benefits.forEach((r, i) => {
      if (r.includes(term)) issues.push({ message: `Found exclusionary term: ${term} in benefit ${i + 1}`, text: r });
    });
  });
  return issues;
}

/**
 * Exports job description in ATS compatible format
 * @param jd - JobDescription object
 * @returns Plain text string
 */
function exportATS(jd: JobDescription): string {
  return `Title: ${jd.title}\nLevel: ${jd.level}\nTeam: ${jd.team}\nSummary: ${jd.summary}\nResponsibilities: ${jd.responsibilities.join(', ')}\nRequirements: ${jd.requirements.join(', ')}\nBenefits: ${jd.benefits.join(', ')}`;
}