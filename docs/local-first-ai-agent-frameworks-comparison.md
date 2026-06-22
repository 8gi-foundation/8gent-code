# Local-First AI Agent Frameworks: Top 3 Comparison

*Research date: June 2026. Criteria: active maintenance, true local LLM support (Ollama, LM Studio, vLLM, GPT4All), tool use, persistent storage, open source.*

---

## TL;DR

| Framework | Best For | Local LLM | Stars | License |
|-----------|----------|-----------|-------|---------|
| **Smolagents** | Fastest single-agent loop | Ollama, HF, any OpenAI-compatible | 27.7k | Apache 2.0 |
| **LangGraph** | Enterprise stateful workflows | Ollama, any via LangChain | 33.9k | MIT |
| **Mastra** | TypeScript/Next.js teams | Ollama, 81+ providers via Vercel AI SDK | 24.8k | MIT |

---

## 1. Smolagents (Hugging Face)

**Website:** https://github.com/huggingface/smolagents

### What it is
Hugging Face's minimalist agent framework. The LLM writes Python code at each step to invoke tools. Sandboxed execution means you get safety without a complex permission system.

### Key Facts
- Stars: ~27,700
- Released: January 2025
- Language: Python
- License: Apache 2.0
- Monthly downloads: ~2.5M

### Local LLM Support
Full support via Hugging Face endpoints, Ollama, LM Studio, or any OpenAI-compatible API. Zero cloud dependency required.

### Strengths
- Fastest path from zero to a working agent loop (under 50 lines of config)
- Sandboxed Python execution is safe and direct
- `ToolCallingAgent` variant available if you prefer standard JSON function calling over code generation
- Active Hugging Face backing with frequent releases
- Lightweight: no heavy dependencies

### Weaknesses
- Single-agent only; no multi-agent orchestration
- No built-in RAG or vector store integration
- Limited observability tooling out of the box
- Not designed for complex enterprise state management

### When to pick it
You want a quick, minimal agent for a specific task and you are comfortable in Python. Ideal for data extraction, research scripts, and automation workflows where you control the scope.

---

## 2. LangGraph (LangChain)

**Website:** https://github.com/langchain-ai/langgraph

### What it is
A stateful agent orchestration framework built on top of LangChain. Agents maintain context across interactions using a directed graph model. Supports streaming, human-in-the-loop, and multi-agent flows.

### Key Facts
- Stars: ~33,900
- Released: 2024
- Language: Python
- License: MIT
- Monthly downloads: 34.5M

### Local LLM Support
Works with Ollama, any LangChain-supported local model, or cloud providers. LangChain has the broadest LLM connector ecosystem of any framework on this list.

### Strengths
- Most mature multi-agent orchestration with explicit graph model
- Human-in-the-loop via suspend/resume workflows
- Streaming support throughout
- Production-trusted: Klarna, Cisco, Uber, LinkedIn, BlackRock, JPMorgan all run LangGraph in production
- Long-term memory and RAG integrations built in
- LangSmith for monitoring and tracing

### Weaknesses
- Steeper learning curve than smolagents or CrewAI
- LangChain abstraction layers can fight you as complexity grows
- Heavier weight: 34.5M monthly downloads worth of dependencies
- Some developer complaints about over-abstraction at scale

### When to pick it
You need enterprise-grade state management, multi-agent coordination, or human-in-the-loop approval steps. You are comfortable with a graph-based mental model and want full visibility into what the agent is doing at each node.

---

## 3. Mastra

**Website:** https://github.com/getmastra/mastra

### What it is
A TypeScript-first agent framework for JavaScript and Next.js teams. Ships with a local dev playground, graph-based workflows, and a four-tier memory system. Backed by Y Combinator and a $13M seed round.

### Key Facts
- Stars: ~24,800
- Released: August 2024, v1.0 January 2026
- Language: TypeScript/JavaScript
- License: MIT
- Monthly NPM downloads: 1.77M

### Local LLM Support
Works with Ollama and 81+ LLM providers via the Vercel AI SDK. Local-first by default; cloud is opt-in.

### Strengths
- Only serious TypeScript-first option for agent development
- Graph-based workflows with `.then()`, `.branch()`, and `.parallel()` primitives
- Four-tier memory: message history, working memory, semantic recall, RAG
- Native OpenTelemetry for observability
- Local dev playground in the browser for testing and visualization
- `.network()` method turns any agent into a routing agent that delegates to sub-agents
- Production users: Replit (Agent 3), Marsh McLennan (75k employees), Softbank (Satto Workspace)

### Weaknesses
- TypeScript-only: Python ML teams cannot use it directly
- Smaller ecosystem than LangGraph or CrewAI
- Some growing pains around integration breadth
- Newer than the others: v1.0 only shipped January 2026

### When to pick it
You are a JavaScript/TypeScript developer building on Next.js or a Node.js stack. You want agents without switching to Python. You value TypeScript type safety and want the dev tooling (playground, tracing) that comes with it.

---

## Comparison Matrix

| Criteria | Smolagents | LangGraph | Mastra |
|----------|-----------|-----------|--------|
| Language | Python | Python | TypeScript |
| Local LLM (true) | Yes (Ollama, HF) | Yes (Ollama, any LC) | Yes (Ollama, Vercel AI SDK) |
| Multi-agent | No | Yes | Yes |
| RAG built-in | No | Yes | Yes |
| Memory model | None (session only) | Long-term via LangChain | 4-tier (history, working, semantic, RAG) |
| Human-in-the-loop | No | Yes (suspend/resume) | Yes (workflow suspend) |
| Observability | Basic | LangSmith | OpenTelemetry native |
| Learning curve | Low | High | Medium |
| Production scale | Single-task | Enterprise | Mid-market |
| License | Apache 2.0 | MIT | MIT |
| Active maintenance | Yes (HF-backed) | Yes | Yes (YC-backed) |

---

## Decision Guide

- **Fastest single-agent, zero boilerplate:** Smolagents. Under 50 lines. Runs locally. Done.
- **Enterprise multi-agent with full control:** LangGraph. Explicit graph model. Human-in-the-loop. Production proven at scale.
- **TypeScript/Next.js stack, want to stay in JS:** Mastra. Only real option. Type-safe. Good dev tooling.

All three support true local-first operation with Ollama or compatible runtimes. None require cloud APIs by default.

---

*Sources: GitHub stars and activity as of June 2026, verified via github.com, aimagicx.com, firecrawl.dev, fast.io*