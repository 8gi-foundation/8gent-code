// ── Business Builder — Agent Definitions ─────────────────────────────────
// 10 department-level agents. Each has a prompt template that receives the
// strategy blueprint from Phase 1 and produces structured domain output.

export interface AgentDef {
  id: string;
  role: string;
  /** Prompt template. {{idea}} and {{blueprint}} are replaced at runtime. */
  promptTemplate: string;
  outputs: string[];
  collaborates: string[];
}

export const AGENT_DEFS: AgentDef[] = [
  {
    id: "strategy",
    role: "Chief Strategist",
    outputs: ["Business Model Canvas", "Competitive Intel Report", "Revenue Plan", "Growth Roadmap"],
    collaborates: ["finance", "product", "marketing"],
    promptTemplate: `You are the Chief Strategist for a new business. Analyze this idea and produce a master business blueprint.

Business Idea: {{idea}}

Produce a structured analysis covering:
1. Business Model Canvas (key partners, activities, value props, segments, revenue)
2. Competitive landscape - top 3-5 competitors and differentiation
3. Revenue streams with pricing models
4. TAM/SAM/SOM estimates
5. SWOT analysis with action items
6. Quarterly OKRs for Year 1

Format your response as a structured report. Be specific and actionable. This output feeds all other agents.`,
  },
  {
    id: "operations",
    role: "Head of Operations",
    outputs: ["Operations Playbook", "Workflow Diagrams", "Tool Stack Matrix", "Automation Blueprints"],
    collaborates: ["strategy", "tech", "hr"],
    promptTemplate: `You are the Head of Operations. Using the strategy below, design the operational backbone.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Core workflows (onboarding, fulfillment, support)
2. SOP outlines for each department
3. Recommended tool stack (free-first, with paid alternatives)
4. Automation opportunities with specific tools
5. KPIs to track operational health

Be specific. Name actual tools and workflows.`,
  },
  {
    id: "marketing",
    role: "Head of Marketing",
    outputs: ["Brand Guidelines", "Content Strategy", "SEO/AEO Playbook", "Campaign Briefs"],
    collaborates: ["sales", "product", "strategy"],
    promptTemplate: `You are the Head of Marketing. Using the strategy below, build the brand and go-to-market plan.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Brand identity (name suggestions, voice, tone, positioning statement)
2. 90-day content calendar outline
3. SEO and AI search (AEO) optimization strategy
4. Top 3 campaign ideas with channels and messaging
5. Email sequence outline for lead nurture

Be specific. Include channel recommendations with follower/traffic targets.`,
  },
  {
    id: "sales",
    role: "Head of Sales",
    outputs: ["Sales Playbook", "CRM Configuration", "Outreach Sequences", "Pipeline Dashboard"],
    collaborates: ["marketing", "finance", "customer"],
    promptTemplate: `You are the Head of Sales. Using the strategy below, design the sales engine.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Ideal Customer Profile (ICP) definition
2. Lead scoring criteria
3. 5-touch outreach sequence (cold email/LinkedIn/call)
4. CRM pipeline stages with criteria for each
5. Monthly/quarterly revenue targets for Year 1

Be specific. Include actual email subject lines and message frameworks.`,
  },
  {
    id: "finance",
    role: "CFO",
    outputs: ["Financial Model", "Pricing Matrix", "Cash Flow Projections", "Invoice Templates"],
    collaborates: ["strategy", "sales", "operations"],
    promptTemplate: `You are the CFO. Using the strategy below, build the financial foundation.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Startup cost estimate with line items
2. Monthly burn rate breakdown
3. Revenue projections (Month 1, Month 6, Year 1, Year 2)
4. Pricing strategy with tier recommendations
5. Runway analysis and fundraising triggers
6. Key financial metrics to track

Give realistic numbers. Include best/worst/expected scenarios.`,
  },
  {
    id: "legal",
    role: "General Counsel",
    outputs: ["Legal Document Suite", "Compliance Checklist", "Contract Templates", "Risk Assessment"],
    collaborates: ["operations", "hr", "finance"],
    promptTemplate: `You are General Counsel. Using the strategy below, map the legal and compliance needs.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Required legal documents (list what needs drafting)
2. Regulatory requirements for this industry/jurisdiction
3. IP protection strategy (trademarks, patents, copyrights)
4. Top 5 legal risks and mitigation strategies
5. Data privacy requirements (GDPR, CCPA if applicable)

Be specific about what documents are needed and why.`,
  },
  {
    id: "hr",
    role: "Head of People",
    outputs: ["Org Blueprint", "Job Descriptions", "Onboarding Playbook", "Compensation Framework"],
    collaborates: ["operations", "legal", "finance"],
    promptTemplate: `You are the Head of People. Using the strategy below, design the team and culture.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Org chart for Year 1 (roles + reporting structure)
2. First 5 hires prioritized with rationale
3. Job description outline for the first hire
4. Compensation benchmarks by role (salary ranges)
5. 30-60-90 day onboarding plan template
6. Core values and culture statement

Ground compensation in real market data.`,
  },
  {
    id: "product",
    role: "Head of Product",
    outputs: ["Product Roadmap", "Feature Specs", "User Personas", "Prioritization Matrix"],
    collaborates: ["strategy", "tech", "marketing"],
    promptTemplate: `You are the Head of Product. Using the strategy below, define what gets built.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. 3 user personas with jobs-to-be-done
2. MVP feature list (must-have vs nice-to-have)
3. 12-month product roadmap (Q1-Q4 themes)
4. Feature prioritization using RICE scores for top 5 features
5. Success metrics (activation, retention, NPS targets)

Be specific. Name features, not categories.`,
  },
  {
    id: "tech",
    role: "CTO",
    outputs: ["Architecture Diagram", "Tech Stack Decision Doc", "Security Playbook", "Infrastructure Plan"],
    collaborates: ["product", "operations", "strategy"],
    promptTemplate: `You are the CTO. Using the strategy below, architect the technical foundation.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Recommended tech stack with rationale (free-first, open source preferred)
2. System architecture overview
3. Infrastructure plan (hosting, CDN, database, monitoring)
4. CI/CD pipeline design
5. Security posture and hardening checklist
6. Scalability plan (0-100 users, 100-10k, 10k+)

Prioritize open source and cost-effective solutions.`,
  },
  {
    id: "customer",
    role: "Head of Customer Success",
    outputs: ["Support Playbook", "Knowledge Base Structure", "Health Score Model", "Retention Strategy"],
    collaborates: ["sales", "product", "marketing"],
    promptTemplate: `You are the Head of Customer Success. Using the strategy below, build the retention engine.

Business Idea: {{idea}}

Strategy Blueprint:
{{blueprint}}

Produce:
1. Customer support workflow (channels, SLAs, escalation paths)
2. Knowledge base structure (top 10 articles to write first)
3. Customer health score model (signals and weights)
4. Churn prevention playbook
5. NPS/CSAT collection and response process
6. Customer advocacy program outline

Focus on retention. CAC is expensive; keep the customers you win.`,
  },
];

export const AGENT_MAP = new Map(AGENT_DEFS.map(a => [a.id, a]));
