# Local-First AI Agent Frameworks: Top 3 Comparison

**Date:** June 2026  
**Purpose:** Research for 8gent ecosystem (local-first, privacy-preserving AI)

---

## TL;DR

| Framework | Best For | Local-First Score | License |
|-----------|----------|-------------------|---------|
| **Smolagents** | Open model workflows, edge deployment | 10/10 | Apache 2.0 |
| **Agno** | Production agents with memory | 9/10 | Apache 2.0 |
| **LangGraph + Ollama** | Structured workflows, graph-based control | 8/10 | MIT |

---

## 1. Smolagents (Hugging Face)

**Repo:** https://github.com/huggingface/smolagents  
**License:** Apache 2.0

### What it is
Hugging Face's lightweight agent framework designed from the ground up for open-source models. No vendor lock-in, no API key required. Runs entirely local.

### Key Features
- **ToolCallingAgent / CodeAgent** - Two agent types: tool-calling (OpenAI-style) and code-writing agents
- **Built-in Hugging Face toolchain** - Search, download, inference directly from HF Hub
- **Local-first by default** - Works with any Ollama, vLLM, or HF Inference Endpoint
- **Minimal dependencies** - Smaller footprint than LangChain
- **Streaming support** - Real-time token output

### Local-First Details
- Compatible with Ollama out of the box
- Works with GGUF quantized models via llama.cpp
- No telemetry or cloud dependency
- Full control over model choice (LLaMA, Mistral, Phi, Qwen, etc.)

### Pros
- Small-model friendly (tested down to 3B params)
- Excellent for HF ecosystem users
- Verbose tracing and metrics out of the box
- Active development by Hugging Face team

### Cons
- Documentation is rough; hard to discover patterns
- Limited production tooling compared to LangGraph
- Smaller community than LangChain

### Use Case for 8gent
Powers local model agents in 8gent Jr and H app. Can run on-device inference with quantized models.

---

## 2. Agno

**Repo:** https://github.com/agno/agno  
**License:** Apache 2.0

### What it is
A production-grade agent framework with one of the best developer experiences in the space. Built for teams that want structured agentic workflows without enterprise complexity.

### Key Features
- **Session memory abstraction** - Clear session semantics for multi-turn conversations
- **Multi-model support** - Switch between providers seamlessly (Ollama, OpenAI, Anthropic, etc.)
- **Reasoning tools** - Built-in structured reasoning patterns
- **Vector storage integration** - Native RAG support
- **Excellent documentation** - Docs are genuinely good, unlike most OSS

### Local-First Details
- Full Ollama integration
- Local model by default unless cloud explicitly configured
- Session memory stays local (no cloud sync required)
- Can run with fully offline models

### Pros
- Clean, consistent API design
- Great docs and source readability
- Agent memory is first-class, not bolted on
- Multi-agent orchestration built in

### Cons
- Requires stringified tool outputs (minor friction)
- Newer project, smaller ecosystem
- Less battle-tested at extreme scale than LangGraph

### Use Case for 8gent
Backend agent orchestration in 8gent OS. Powers agent memory and session management for the personal AI OS layer.

---

## 3. LangGraph + Ollama

**Repo:** https://github.com/langchain-ai/langgraph  
**License:** MIT

### What it is
LangGraph extends LangChain with graph-based state machines for agents. Paired with Ollama for local inference, this is the most flexible option for complex agentic workflows.

### Key Features
- **Graph-based state management** - Full control over agent flow as a directed graph
- **Checkpointing** - Resume agent runs from any state
- **Async + streaming** - First-class support for both
- **Tool-calling compatibility** - OpenAI tool format compatible
- **Large ecosystem** - LangChain has integrations for almost everything

### Local-First Details
- Ollama integration via `langchain-ollama` package
- All data stays local (no cloud dependency)
- Checkpointing allows persistent agent state locally
- Full LangChain RAG stack available offline

### Pros
- Most flexible architecture (graph = any flow)
- Checkpointing enables complex resume/suspend scenarios
- Battle-tested in production at scale
- Largest community and plugin ecosystem

### Cons
- Documentation sprawl (multiple conflicting patterns)
- Bloated imports; poor developer ergonomics
- Steep learning curve
- LangChain baggage: some abstractions feel legacy

### Use Case for 8gent
Complex agent workflows requiring multi-step reasoning with memory persistence. Good fit for the 8GI governance agent or policy analysis agents.

---

## Honorable Mentions

- **Ollama + raw Python loop** - Zero dependency, maximum control. Educational. Not production-grade without scaffolding.
- **Jan (jan.ai)** - Fully local AI assistant with agent capabilities. Desktop app focus.
- **LM Studio** - Local inference primarily; not a framework but often used as backend for agents.
- **PydanticAI** - Type-safe but less local-first focused than the top 3.

---

## Decision Matrix for 8gent

| Criterion | Smolagents | Agno | LangGraph + Ollama |
|-----------|-----------|------|--------------------|
| Local by default | +++ | ++ | + |
| Open model support | +++ | ++ | ++ |
| Developer experience | ++ | +++ | + |
| Production maturity | ++ | ++ | +++ |
| Multi-agent support | ++ | +++ | +++ |
| Memory/State | + | +++ | +++ |
| 8gent Jr fit | +++ | ++ | + |
| 8gent OS fit | ++ | +++ | +++ |

---

## Recommendation

For the 8gent ecosystem:

- **8gent Jr / H app:** Smolagents as the primary agent framework. Runs quantized models on-device, zero cloud dependency, small footprint.
- **8gent OS backend:** Agno for session management and multi-agent orchestration. Clean API, excellent local support.
- **Complex workflows (policy agents, governance):** LangGraph + Ollama for graph-based control flow and checkpointing.

All three are Apache 2.0 or MIT licensed. All work fully offline. No vendor lock-in.

---

*Research completed: June 2026. Local-first AI agent landscape is evolving rapidly; re-evaluate quarterly.*
