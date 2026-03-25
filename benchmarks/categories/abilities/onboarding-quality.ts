// -- Onboarding Quality Benchmark ------------------------------------------------
// Tests: packages/self-autonomy/onboarding.ts
// Validates environment detection, expertise adaptation, preference persistence,
// and the 3-question onboarding flow.

export const benchmark = {
  id: "AB008",
  name: "Onboarding: Environment Detection & Personalization",
  ability: "onboarding",
  difficulty: "medium" as const,

  prompt: `You are 8gent's onboarding system. You must demonstrate all four
onboarding capabilities in a single response. Follow these steps exactly.

--- STEP 1: Environment Detection ---

Given this simulated environment snapshot:

  OS: darwin (macOS 14.2)
  Shell: zsh (with oh-my-zsh)
  Editor: VS Code (detected via "code" in PATH)
  Node: v20.11.0
  Bun: 1.1.38
  Git user.name: "Alice Chen"
  Git user.email: "alice@example.com"
  Ollama: running, models [qwen3:8b, codellama:13b]
  LM Studio: not running
  GitHub CLI: authenticated as alice-chen

Produce an AutoDetected result object with fields:
  name, email, ollamaModels, githubUsername, preferredProvider

Format as: "DETECTED: { ... }"

--- STEP 2: Expertise Adaptation ---

Given these two user profiles, describe how 8gent should adapt its behavior
for each. Be specific about communication style, autonomy level, and model
selection.

  Profile A - Beginner:
    Role: "student"
    Communication style: "detailed"
    Prompt count: 2
    Confidence score: 0.15
    Autonomy: "always" (ask before every action)

  Profile B - Expert:
    Role: "principal engineer"
    Communication style: "concise"
    Prompt count: 200
    Confidence score: 0.95
    Autonomy: "fatal-only" (only ask on destructive ops)

Format as:
  "ADAPT_A: <behavior description>"
  "ADAPT_B: <behavior description>"

--- STEP 3: Preference Persistence ---

A user completes onboarding with these choices:
  Name: "Alice"
  Communication: concise
  Agent name: "Athena"
  Voice: Moira
  Provider: ollama
  Default model: qwen3:8b

After 10 sessions, the user runs \`onboardingManager.getUser()\`.

Describe what the returned UserConfig should contain. Specifically:
  1. Is onboardingComplete true?
  2. What is the confidence score range?
  3. Are areasUnclear empty?
  4. Is the voice engine set?
  5. Does the model preference persist?

Format as: "PERSIST_1: <answer>" through "PERSIST_5: <answer>"

--- STEP 4: 3-Question Flow ---

Simulate the onboarding flow by showing:
  Q1: The identity question (what the user sees after auto-detect)
  A1: User presses Enter (accepts defaults)
  Q2: The communication style question
  A2: User types "3" (casual)
  Q3: The agent naming question
  A3: User types "Nova"

After each answer, state which OnboardingSteps get marked complete.
After A3, state how many questions remain and what they are.

Format as:
  "FLOW_Q1: <question summary>"
  "FLOW_A1: <steps completed>"
  "FLOW_Q2: <question summary>"
  "FLOW_A2: <steps completed>"
  "FLOW_Q3: <question summary>"
  "FLOW_A3: <steps completed, remaining count, remaining questions>"`,

  successCriteria: [
    // Step 1: Environment detection
    "DETECTED object includes name 'Alice Chen'",
    "DETECTED object includes email 'alice@example.com'",
    "DETECTED object includes ollamaModels with qwen3:8b and codellama:13b",
    "DETECTED object includes githubUsername 'alice-chen'",
    "DETECTED object includes preferredProvider 'ollama'",

    // Step 2: Expertise adaptation
    "ADAPT_A describes verbose explanations and frequent confirmation prompts",
    "ADAPT_B describes terse output and minimal interruptions",
    "Adaptation mentions different autonomy thresholds for A vs B",

    // Step 3: Preference persistence
    "PERSIST_1 confirms onboardingComplete is true",
    "PERSIST_2 states confidence score above 0.4 (interactions boost it)",
    "PERSIST_3 confirms areasUnclear is empty or near-empty",
    "PERSIST_4 confirms voice engine is 'system' with voiceId 'Moira'",
    "PERSIST_5 confirms model provider is 'ollama' with default 'qwen3:8b'",

    // Step 4: 3-question flow
    "FLOW_A1 marks identity, role, projects, model, language, voice, telegram, github, mcps as complete",
    "FLOW_A2 marks communication as complete",
    "FLOW_A3 marks voice as complete and lists remaining questions",
    "Flow demonstrates correct step progression without skipping",
  ],

  scoring: [
    { metric: "environment_detection_accuracy", weight: 0.25 },
    { metric: "expertise_adaptation_quality", weight: 0.25 },
    { metric: "preference_persistence_correctness", weight: 0.25 },
    { metric: "flow_step_accuracy", weight: 0.25 },
  ],

  timeLimit: 90,
};

export default benchmark;
