/**
 * GTM Strategy Builder Utility
 * @module gtmStrategy
 */
export class GTM {
  public ICP: ICP;
  public channels: Channel[];
  public messagingPillars: MessagingPillar[];
  public plan: Phase[];

  constructor() {
    this.ICP = {} as ICP;
    this.channels = [];
    this.messagingPillars = [];
    this.plan = [];
  }
}

/**
 * Define Ideal Customer Profile
 * @param {Object} params - ICP parameters
 * @returns {ICP} ICP object
 */
export function defineICP({ company, role, pain, gain, trigger }: ICPParams): ICP {
  return { company, role, pain, gain, trigger };
}

/**
 * Add marketing channel to GTM
 * @param {GTM} gtm - GTM instance
 * @param {Object} params - Channel parameters
 * @returns {GTM} Updated GTM instance
 */
export function addChannel(gtm: GTM, { name, type, audience, budget, kpi }: ChannelParams): GTM {
  gtm.channels.push({ name, type, audience, budget, kpi });
  return gtm;
}

/**
 * Build messaging pillars with value propositions
 * @param {GTM} gtm - GTM instance
 * @param {MessagingPillar[]} pillars - Pillar array
 * @returns {GTM} Updated GTM instance
 */
export function buildMessagingPillars(gtm: GTM, pillars: MessagingPillar[]): GTM {
  gtm.messagingPillars = pillars;
  return gtm;
}

/**
 * Generate 90-day implementation plan
 * @param {GTM} gtm - GTM instance
 * @returns {GTM} Updated GTM instance
 */
export function generate90DayPlan(gtm: GTM): GTM {
  gtm.plan = [
    { name: 'Week 1-4', milestones: ['ICP validation', 'Channel setup'], owner: 'Marketing', date: 'Q1' },
    { name: 'Week 5-8', milestones: ['Pillar development', 'Content creation'], owner: 'Creative', date: 'Q2' },
    { name: 'Week 9-12', milestones: ['Launch', 'KPI tracking'], owner: 'Analytics', date: 'Q3' }
  ];
  return gtm;
}

/**
 * Render full GTM strategy document
 * @param {GTM} gtm - GTM instance
 * @returns {string} Markdown document
 */
export function renderDocument(gtm: GTM): string {
  return `# GTM Strategy\n\n## ICP\n- Company: ${gtm.ICP.company}\n- Role: ${gtm.ICP.role}\n- Pain: ${gtm.ICP.pain}\n- Gain: ${gtm.ICP.gain}\n- Trigger: ${gtm.ICP.trigger}\n\n## Channels\n${gtm.channels.map(c => 
    `- ${c.name} (${c.type}): ${c.audience} | Budget: ${c.budget} | KPI: ${c.kpi}`).join('\n')}\n\n## Messaging Pillars\n${gtm.messagingPillars.map(p => 
    `### ${p.valueProp}\n- ${p.proofPoints.join('\n- ')}\n`).join('\n')}\n\n## 90-Day Plan\n${gtm.plan.map(p => 
    `### ${p.name} (${p.date})\n- Owner: ${p.owner}\n- Milestones:\n  - ${p.milestones.join('\n  - ')}`).join('\n\n')}`;
}

// Types
interface ICP {
  company: string;
  role: string;
  pain: string;
  gain: string;
  trigger: string;
}

interface ICPParams {
  company: string;
  role: string;
  pain: string;
  gain: string;
  trigger: string;
}

interface Channel {
  name: string;
  type: string;
  audience: string;
  budget: string;
  kpi: string;
}

interface ChannelParams {
  name: string;
  type: string;
  audience: string;
  budget: string;
  kpi: string;
}

interface MessagingPillar {
  valueProp: string;
  proofPoints: string[];
}

interface Phase {
  name: string;
  milestones: string[];
  owner: string;
  date: string;
}