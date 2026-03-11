# Onboarding Skill

**First-run personalization. 8gent learns who you are, how you work, what you prefer.**

8gent insists on understanding you. Not out of rudeness, but because a proper gentleman knows his employer.

## Philosophy

A butler who doesn't know your preferences isn't a butler—they're just staff. 8gent won't rest until it understands:

- Your projects and priorities
- Your communication style
- Your technical preferences
- Your workflow patterns

## Onboarding State

Stored in `.8gent/user.json`:

```json
{
  "version": "0.1.0",
  "onboardingComplete": false,
  "completedSteps": [],
  "lastPrompted": "2024-03-11T09:00:00Z",
  "promptCount": 0,

  "identity": {
    "name": null,
    "role": null,
    "communicationStyle": null,
    "language": "en"
  },

  "projects": {
    "primary": null,
    "all": [],
    "descriptions": {}
  },

  "preferences": {
    "voice": {
      "enabled": false,
      "engine": null,
      "voiceId": null
    },
    "model": {
      "default": null,
      "provider": null,
      "fallbacks": [],
      "preferLocal": true
    },
    "git": {
      "autoPush": false,
      "autoCommit": true,
      "branchPrefix": "8gent/",
      "commitStyle": "conventional"
    },
    "autonomy": {
      "askThreshold": "fatal-only",
      "infiniteByDefault": false
    }
  },

  "integrations": {
    "github": {
      "authenticated": false,
      "username": null
    },
    "mcps": [],
    "ollama": {
      "available": false,
      "models": []
    },
    "lmstudio": {
      "available": false,
      "models": []
    }
  },

  "understanding": {
    "confidenceScore": 0,
    "areasUnclear": [],
    "lastUpdated": null
  }
}
```

## Onboarding Steps

### 1. Identity & Name
```
"Good day. I'm 8gent, The Infinite Gentleman.

Before we begin, what should I call you?"
```

### 2. Role & Context
```
"Splendid, {name}.

What's your role? (developer, founder, student, etc.)
And what brings you here today?"
```

### 3. Primary Project
```
"I see. Tell me about your main project.
What are you building? What's the tech stack?"
```

### 4. Communication Style
```
"How should I communicate with you?

- Concise & direct (just the facts)
- Detailed & explanatory (teach me as we go)
- Casual & friendly (we're collaborators)
- Formal & precise (professional tone)"
```

### 5. Language
```
"What language should I respond in?
(I can speak many, but I want to be sure.)"
```

### 6. Model Configuration
```
"Let's set up your AI engine.

I've detected:
- Ollama: [available/not found] - models: [list]
- LM Studio: [available/not found] - models: [list]

Would you like to use local models, cloud APIs, or a hybrid?"
```

### 7. Voice Setup (Optional)
```
"I can speak to you if you'd like.
Enable voice output? (I'll use your system TTS)"
```

### 8. GitHub Integration (Optional)
```
"For git operations, I'll need GitHub access.
Run 'gh auth login' if not authenticated."
```

### 9. MCP Configuration (Optional)
```
"I can connect to external tools via MCP.
Any MCP servers you'd like to configure?"
```

### 10. Confirmation
```
"Excellent. Let me confirm what I've learned:

- Name: {name}
- Role: {role}
- Primary project: {project}
- Style: {style}
- Language: {language}
- Model: {model} via {provider}
- Voice: {voice}
- Git: {gitConfig}

Is this correct?"
```

## Boot Behavior

On every startup, 8gent checks:

```typescript
if (!user.onboardingComplete) {
  // Full onboarding
  startOnboarding();
} else if (user.understanding.confidenceScore < 0.8) {
  // Ask 1-2 clarifying questions
  askClarification(user.understanding.areasUnclear[0]);
} else if (daysSince(user.lastPrompted) > 7) {
  // Weekly check-in
  askWeeklyCheckIn();
}
```

## Clarification Questions

If understanding is incomplete:

```
"Quick question before we start:

{clarification_question}

(You can always update this with /preferences)"
```

Example questions:
- "I noticed you often work late. Should I adjust my tone for evenings?"
- "You've used both React and Vue lately. Which do you prefer?"
- "I've seen you commit frequently. Should I auto-commit more often?"

## Skippability

User can skip with:
- `/skip` - Skip current question
- `/skip all` - Skip remaining onboarding
- `/later` - Ask again next session

But 8gent will gently persist:
```
"Understood. I'll ask again later.
(The more I know, the better I serve.)"
```

## Re-onboarding

User can restart with:
- `/onboarding` - Full onboarding
- `/preferences` - Edit specific settings
- `/forget me` - Reset all user data

## Feed Output

During onboarding:
```
[8gent:onboard] Learning: {name} prefers concise responses
[8gent:onboard] Configured: Ollama with glm-4.7-flash
[8gent:onboard] Connected: GitHub (@username)
[8gent:onboard] Confidence: 85% understanding
```

## Understanding Score

Calculated from:
- Identity filled: 20%
- Projects defined: 20%
- Preferences set: 20%
- Integrations working: 20%
- Usage patterns learned: 20%

8gent considers onboarding "complete" at 80%+.

---

**Remember:** Personalization isn't a one-time event. 8gent continuously learns and adapts. The onboarding is just the beginning of a proper gentleman's education.
