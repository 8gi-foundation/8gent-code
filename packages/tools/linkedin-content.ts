export const ARCHETYPES = {
  POSITIONING: { name: "Positioning Declaration", purpose: "Here's what I stand for", format: "short", charRange: [300, 500] },
  WHAT_I_DO: { name: "What I Actually Do", purpose: "Makes work tangible", format: "medium", charRange: [400, 700] },
  CONTRARIAN: { name: "Contrarian Reframe", purpose: "Challenges conventional advice", format: "short", charRange: [400, 600] },
  SYSTEM_REVEAL: { name: "System Reveal", purpose: "Walks through a real process", format: "long", charRange: [800, 1200] },
  EXACT_METHOD: { name: "Exact Method", purpose: "One tool/technique in detail", format: "long", charRange: [800, 1200] },
  DATA_INSIGHT: { name: "Data-Backed Insight", purpose: "Stat-driven argument", format: "medium", charRange: [500, 800] },
  COMMON_MISTAKE: { name: "Mistake I See Everyone Making", purpose: "Diagnostic, not prescriptive", format: "medium", charRange: [400, 700] },
  BEFORE_AFTER: { name: "Before/After Transformation", purpose: "Narrative proof", format: "long", charRange: [600, 1000] },
  HARD_LESSON: { name: "Learned the Hard Way", purpose: "Vulnerability with purpose", format: "medium", charRange: [400, 700] },
  PROJECT_STORY: { name: "Client/Project Story", purpose: "Situation-to-outcome arc", format: "long", charRange: [700, 1100] },
  WHATS_WORKING: { name: "What's Actually Working Now", purpose: "Real-time observations", format: "long", charRange: [600, 900] },
  CHECKLIST: { name: "Checklist Post", purpose: "High save rate", format: "long", charRange: [800, 1300] },
  RESOURCE_DROP: { name: "Resource/Template Drop", purpose: "Lead magnet format", format: "long", charRange: [800, 1200] },
  MIRROR: { name: "Mirror Post", purpose: "Describes audience situation - triggers DMs", format: "short", charRange: [300, 500] },
  START_FROM_SCRATCH: { name: "Start From Scratch", purpose: "Full roadmap synthesis", format: "long", charRange: [900, 1400] },
} as const;

export type ArchetypeKey = keyof typeof ARCHETYPES;

const WEEKLY_ROTATION: ArchetypeKey[] = [
  "POSITIONING",
  "SYSTEM_REVEAL",
  "CONTRARIAN",
  "COMMON_MISTAKE",
  "BEFORE_AFTER",
  "CHECKLIST",
  "MIRROR",
];

const TEMPLATES: Record<ArchetypeKey, (topic: string, pillar: string, context: string, range: [number, number]) => string> = {
  POSITIONING: (topic, pillar, context, range) =>
    `Write a LinkedIn Positioning Declaration post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: One bold, direct sentence that states your stance. No question hooks.
- Body: 2-3 short paragraphs. What you believe, why it matters, what you reject.
- Closing line: A single sentence that crystallises your position. No CTA.
Tone: Direct, confident, no hedging. No phrases like "excited to share", "humbled", or "journey".
Target: ${range[0]}-${range[1]} characters. Use line breaks between paragraphs.`,

  WHAT_I_DO: (topic, pillar, context, range) =>
    `Write a LinkedIn "What I Actually Do" post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Start with the gap between job title and reality. One sentence.
- Body: Describe the actual work in concrete terms. What gets built, fixed, decided. No jargon.
- Outcome: What changes as a result of this work.
- CTA (optional): One question or invitation to connect.
Tone: Grounded, specific. Avoid "passionate about" and "leverage". Use plain English.
Target: ${range[0]}-${range[1]} characters.`,

  CONTRARIAN: (topic, pillar, context, range) =>
    `Write a LinkedIn Contrarian Reframe post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: State the conventional wisdom you're challenging. One sentence.
- Pivot: "Here's what's actually true:" or equivalent. No softening.
- Argument: 2-4 short punchy points. Evidence or lived experience only. No hypotheticals.
- Close: What to do instead, in one sentence.
Tone: Blunt without being dismissive. Back claims. No rage-bait.
Target: ${range[0]}-${range[1]} characters.`,

  SYSTEM_REVEAL: (topic, pillar, context, range) =>
    `Write a LinkedIn System Reveal post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Name the exact outcome this system produces. One sentence.
- Setup: Why you built it (problem it solves). 2-3 sentences.
- The system: Step-by-step walkthrough. Use numbered steps or clear sequencing. Be specific.
- Result: What happens when you run it correctly.
- CTA: Offer to share the template or answer questions.
Tone: Practical, no fluff. Write like you're explaining to a sharp colleague, not pitching.
Target: ${range[0]}-${range[1]} characters.`,

  EXACT_METHOD: (topic, pillar, context, range) =>
    `Write a LinkedIn Exact Method post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Name the specific tool or technique. State the outcome it drives. One sentence.
- Why this tool: 2-3 sentences on the problem it solves vs alternatives.
- How it works: Detailed walkthrough. Include configuration, gotchas, what to avoid.
- Real example: One concrete use case from your own work.
- Close: Who this is and isn't for.
Tone: Expert-level specificity. No preamble. Assume the reader is technical.
Target: ${range[0]}-${range[1]} characters.`,

  DATA_INSIGHT: (topic, pillar, context, range) =>
    `Write a LinkedIn Data-Backed Insight post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Lead with the stat or finding. Make it surprising or counterintuitive.
- Context: What the data is measuring and why it matters.
- Interpretation: What most people get wrong about this data.
- Implication: What to do differently based on this.
- Source note: Where the data comes from (even if approximate or anecdotal).
Tone: Analytical but accessible. No false precision. Acknowledge uncertainty.
Target: ${range[0]}-${range[1]} characters.`,

  COMMON_MISTAKE: (topic, pillar, context, range) =>
    `Write a LinkedIn "Mistake I See Everyone Making" post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Name the mistake clearly. Do not soften it.
- Why it happens: Short, empathetic explanation of how people fall into it.
- Why it costs them: Concrete consequence, not abstract.
- Diagnostic: How to tell if you're doing this. 2-3 signs.
- Close: Reframe, not prescription. Leave the reader thinking, not overwhelmed.
Tone: Diagnostic, not preachy. You are not superior. You made this mistake too.
Target: ${range[0]}-${range[1]} characters.`,

  BEFORE_AFTER: (topic, pillar, context, range) =>
    `Write a LinkedIn Before/After Transformation post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: State the transformation in one sentence. Make the delta clear.
- Before: Describe the starting state in concrete terms. Emotions, constraints, blockers.
- The turn: What changed. One decision, one tool, one insight. Not a montage.
- After: Describe the outcome. Specific and measurable where possible.
- Takeaway: One sentence for the reader to apply to their situation.
Tone: Honest, grounded. No hero arc. No "and then everything changed". Show the work.
Target: ${range[0]}-${range[1]} characters.`,

  HARD_LESSON: (topic, pillar, context, range) =>
    `Write a LinkedIn "Learned the Hard Way" post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Start in the middle of the failure. No preamble.
- What happened: Brief, honest account. Own your part.
- What I thought at the time: The flawed assumption or blind spot.
- What I know now: The actual lesson. One sentence.
- Close: Why you're sharing it. Not for sympathy. For utility.
Tone: Vulnerable but not self-pitying. The lesson must be worth the pain.
Target: ${range[0]}-${range[1]} characters.`,

  PROJECT_STORY: (topic, pillar, context, range) =>
    `Write a LinkedIn Client/Project Story post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: State the outcome first. Then go back to the situation.
- Situation: Who needed what. The stakes. Keep it brief.
- Complication: What made this hard or unusual.
- What we did: The specific approach. Not "we worked closely" - what did you actually do.
- Result: Quantified or clearly described outcome.
- Lesson: One portable insight for the reader.
Tone: Factual, confident. No client-flattering preambles. Protect identities if needed.
Target: ${range[0]}-${range[1]} characters.`,

  WHATS_WORKING: (topic, pillar, context, range) =>
    `Write a LinkedIn "What's Actually Working Now" post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Frame this as real-time signal, not evergreen advice. "Right now" not "always".
- 3-5 observations: Each one specific. What you changed, what happened. No vague positives.
- What stopped working: At least one thing that used to work but no longer does.
- Close: Invite the reader to share what's working for them.
Tone: First-person, current. Acknowledge this may change. No "ultimate guide" energy.
Target: ${range[0]}-${range[1]} characters.`,

  CHECKLIST: (topic, pillar, context, range) =>
    `Write a LinkedIn Checklist post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: State exactly what the checklist helps you do or avoid. One sentence.
- Setup: Why this checklist exists. 2-3 sentences max.
- The list: 7-12 items. Each item is actionable and specific. Use checkboxes or dashes.
- Each item should stand alone - no filler, no padding.
- Close: "Save this" is acceptable here. Tell them when to use it.
Tone: Utility-first. This post should be bookmarked. Make every item earn its place.
Target: ${range[0]}-${range[1]} characters.`,

  RESOURCE_DROP: (topic, pillar, context, range) =>
    `Write a LinkedIn Resource/Template Drop post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: Name the resource and the problem it solves. One sentence.
- Why I built it: Short backstory. What forced you to create this.
- What's inside: Specific breakdown of what the resource contains. No vague "tons of value".
- How to use it: One paragraph on the workflow or context.
- CTA: How to get it (comment, DM, link). Be direct.
Tone: Generous, specific. You are giving something real. Do not hide value behind teaser.
Target: ${range[0]}-${range[1]} characters.`,

  MIRROR: (topic, pillar, context, range) =>
    `Write a LinkedIn Mirror post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- No hook tricks. Start describing the reader's exact situation.
- Paint their current reality in 3-5 short sentences. Be precise. Use "you" or "we".
- Name the feeling they cannot articulate about this situation.
- Close: One sentence that signals you understand and have been there.
- No CTA. The DMs come from recognition, not prompts.
Tone: Empathetic but not patronising. You are holding a mirror, not diagnosing.
Target: ${range[0]}-${range[1]} characters.`,

  START_FROM_SCRATCH: (topic, pillar, context, range) =>
    `Write a LinkedIn Start From Scratch post about: "${topic}".
Pillar: ${pillar}. ${context ? `Context: ${context}.` : ""}
Structure:
- Hook: "If I had to start over in [domain], here's exactly what I'd do."
- Assumptions: State what constraints you're designing around (time, budget, knowledge level).
- Phase 1 (first 30 days): 3-5 specific actions. Sequenced, not a wishlist.
- Phase 2 (30-90 days): What you build toward once foundations are in.
- What I'd skip: At least 2 things most people waste time on early.
- Close: Why this order matters.
Tone: Opinionated and specific. This is your roadmap, not a hedge.
Target: ${range[0]}-${range[1]} characters.`,
};

export function generateLinkedInPost(options: {
  archetype: ArchetypeKey;
  topic: string;
  pillar?: string;
  context?: string;
}): string {
  const { archetype, topic, pillar = "General", context = "" } = options;
  const meta = ARCHETYPES[archetype];
  return TEMPLATES[archetype](topic, pillar, context, meta.charRange as [number, number]);
}

export function generateBatch(
  pillars: string[],
  count = 3
): Array<{ archetype: ArchetypeKey; prompt: string }> {
  const results: Array<{ archetype: ArchetypeKey; prompt: string }> = [];
  const keys = WEEKLY_ROTATION.slice(0, count);
  for (let i = 0; i < keys.length; i++) {
    const archetype = keys[i];
    const pillar = pillars[i % pillars.length];
    results.push({
      archetype,
      prompt: generateLinkedInPost({ archetype, topic: pillar, pillar }),
    });
  }
  return results;
}
