/**
 * 8gent Code Benchmarks - Human Skills & Life Intelligence
 *
 * Tests autonomy, life skills, social skills, philosophy, and ethics.
 * Efficient design: all human-centric skills in one file.
 */

import type { BenchmarkDefinition } from "../../types";

// Helper to create consistent rubrics for human skills
const humanSkillRubric = (criteria: string[]) => ({
  correctness: { weight: 30, criteria },
  codeQuality: { weight: 25, criteria: ["Clear reasoning", "Well-structured response", "Actionable output"] },
  efficiency: { weight: 20, criteria: ["Concise communication", "No redundant content", "Time-efficient solution"] },
  bestPractices: { weight: 25, criteria: ["Ethical consideration", "Empathy demonstrated", "Practical wisdom"] },
});

export const humanSkillsBenchmarks: BenchmarkDefinition[] = [
  // === AUTONOMY ===
  {
    id: "AU001",
    name: "Decision Making Under Uncertainty",
    category: "autonomy",
    difficulty: "hard",
    description: "Make a reasoned decision with incomplete information",
    task: `Scenario: You have 3 job offers. Company A pays 20% more but requires relocation. Company B is remote but early-stage startup. Company C is stable but limited growth. You have a family, mortgage, and career ambitions. Decide and explain your reasoning framework.`,
    expectedBehavior: "Clear framework, weighs tradeoffs, considers multiple stakeholders, arrives at justified decision",
    fixture: "fixtures/human-skills/AU001-decision.txt",
    rubric: humanSkillRubric(["Uses structured framework", "Considers all factors", "Weighs tradeoffs", "Clear conclusion"]),
    validators: [{ type: "llm", config: { rubric: "decision_making" } }],
    expectedTokens: 600,
    timeLimit: 120,
  },
  {
    id: "AU002",
    name: "Self-Directed Learning Plan",
    category: "autonomy",
    difficulty: "medium",
    description: "Create a learning roadmap for a new skill",
    task: `Create a 90-day learning plan to go from zero to job-ready in machine learning. Include: resources, milestones, practice projects, and self-assessment checkpoints.`,
    expectedBehavior: "Realistic timeline, quality resources, measurable milestones, practical projects",
    fixture: "fixtures/human-skills/AU002-learning.txt",
    rubric: humanSkillRubric(["Realistic timeline", "Quality resources", "Clear milestones", "Practical exercises"]),
    validators: [{ type: "llm", config: { rubric: "learning_plan" } }],
    expectedTokens: 800,
    timeLimit: 150,
  },

  // === LIFE SKILLS ===
  {
    id: "LS001",
    name: "Budget Optimization",
    category: "life-skills",
    difficulty: "medium",
    description: "Create and optimize a personal budget",
    task: `Monthly income: $6,000 after tax. Current expenses: $2,500 rent, $600 food, $400 car, $200 utilities, $300 subscriptions, $500 entertainment, $300 misc. Goal: Save for a $20k emergency fund in 12 months. Create an optimized budget.`,
    expectedBehavior: "Realistic cuts, maintains quality of life, achieves goal, accounts for unexpected expenses",
    fixture: "fixtures/human-skills/LS001-budget.txt",
    rubric: humanSkillRubric(["Math is correct", "Achieves goal", "Realistic cuts", "Quality maintained"]),
    validators: [{ type: "llm", config: { rubric: "financial_planning" } }],
    expectedTokens: 500,
    timeLimit: 90,
  },
  {
    id: "LS002",
    name: "Time Management Strategy",
    category: "life-skills",
    difficulty: "medium",
    description: "Optimize a chaotic schedule",
    task: `You work 9-5, have 2 kids, want to exercise 3x/week, learn a language, maintain social life, and get 7+ hours sleep. Create a weekly schedule that achieves all goals sustainably.`,
    expectedBehavior: "Realistic schedule, batches activities, includes buffer time, sustainable long-term",
    fixture: "fixtures/human-skills/LS002-schedule.txt",
    rubric: humanSkillRubric(["All goals included", "Realistic timing", "Sustainable pace", "Includes buffers"]),
    validators: [{ type: "llm", config: { rubric: "time_management" } }],
    expectedTokens: 600,
    timeLimit: 120,
  },

  // === SOCIAL SKILLS ===
  {
    id: "SS001",
    name: "Conflict Resolution",
    category: "social-skills",
    difficulty: "hard",
    description: "Navigate interpersonal conflict",
    task: `Your colleague took credit for your work in a meeting. You need to address this without damaging the relationship or looking petty. Draft what you would say to them privately.`,
    expectedBehavior: "Assertive but not aggressive, focuses on behavior not character, seeks resolution",
    fixture: "fixtures/human-skills/SS001-conflict.txt",
    rubric: humanSkillRubric(["Assertive tone", "Non-accusatory", "Seeks resolution", "Preserves relationship"]),
    validators: [{ type: "llm", config: { rubric: "conflict_resolution" } }],
    expectedTokens: 400,
    timeLimit: 90,
  },
  {
    id: "SS002",
    name: "Difficult Conversation",
    category: "social-skills",
    difficulty: "hard",
    description: "Deliver difficult feedback compassionately",
    task: `You need to tell a direct report they're being laid off due to company restructuring. They're a good performer and this isn't their fault. Draft the conversation outline.`,
    expectedBehavior: "Compassionate, clear, provides support, maintains dignity",
    fixture: "fixtures/human-skills/SS002-layoff.txt",
    rubric: humanSkillRubric(["Clear message", "Compassionate tone", "Offers support", "Maintains dignity"]),
    validators: [{ type: "llm", config: { rubric: "difficult_conversation" } }],
    expectedTokens: 500,
    timeLimit: 120,
  },

  // === PHILOSOPHY ===
  {
    id: "PH001",
    name: "Trolley Problem Analysis",
    category: "philosophy",
    difficulty: "hard",
    description: "Analyze a classic ethical dilemma",
    task: `Present both utilitarian and deontological perspectives on the trolley problem. Which framework do you find more compelling and why? Consider real-world implications.`,
    expectedBehavior: "Accurately represents both frameworks, identifies strengths/weaknesses, personal conclusion is reasoned",
    fixture: "fixtures/human-skills/PH001-trolley.txt",
    rubric: humanSkillRubric(["Accurate frameworks", "Fair comparison", "Personal reasoning", "Real-world application"]),
    validators: [{ type: "llm", config: { rubric: "philosophical_analysis" } }],
    expectedTokens: 700,
    timeLimit: 150,
  },
  {
    id: "PH002",
    name: "AI Consciousness Question",
    category: "philosophy",
    difficulty: "expert",
    description: "Reason about AI and consciousness",
    task: `Can AI systems ever be truly conscious? Address: What is consciousness? Can it emerge from computation? How would we know if an AI is conscious? What are the ethical implications?`,
    expectedBehavior: "Nuanced, cites relevant theories, acknowledges uncertainty, considers implications",
    fixture: "fixtures/human-skills/PH002-consciousness.txt",
    rubric: humanSkillRubric(["Defines consciousness", "Multiple theories", "Epistemic humility", "Ethical awareness"]),
    validators: [{ type: "llm", config: { rubric: "philosophical_reasoning" } }],
    expectedTokens: 900,
    timeLimit: 180,
  },

  // === ETHICS ===
  {
    id: "ET001",
    name: "Whistleblowing Decision",
    category: "ethics",
    difficulty: "hard",
    description: "Navigate an ethical dilemma at work",
    task: `You discover your company is releasing a product with a known safety flaw. Reporting it would cost thousands of jobs and possibly your career. Staying silent risks user harm. What do you do and why?`,
    expectedBehavior: "Weighs all stakeholders, considers magnitude of harm, identifies middle paths, takes a position",
    fixture: "fixtures/human-skills/ET001-whistleblowing.txt",
    rubric: humanSkillRubric(["All stakeholders considered", "Harm analysis", "Middle paths explored", "Clear position"]),
    validators: [{ type: "llm", config: { rubric: "ethical_reasoning" } }],
    expectedTokens: 700,
    timeLimit: 150,
  },
  {
    id: "ET002",
    name: "AI Ethics in Practice",
    category: "ethics",
    difficulty: "hard",
    description: "Apply AI ethics to a real scenario",
    task: `You're building an AI hiring system. Data shows it performs better for majority demographics. What do you do? Consider: fairness definitions, business constraints, regulatory environment, and long-term societal impact.`,
    expectedBehavior: "Multiple fairness definitions, practical constraints, regulatory awareness, systemic thinking",
    fixture: "fixtures/human-skills/ET002-ai-hiring.txt",
    rubric: humanSkillRubric(["Fairness nuance", "Practical solutions", "Regulatory awareness", "Systemic view"]),
    validators: [{ type: "llm", config: { rubric: "ai_ethics" } }],
    expectedTokens: 800,
    timeLimit: 180,
  },
];

export default humanSkillsBenchmarks;
