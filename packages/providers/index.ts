/**
 * 8gent Code - LLM Provider Abstraction Layer
 *
 * Unified interface for multiple LLM providers:
 * - Ollama (default, local)
 * - OpenRouter (multi-model gateway)
 * - Groq (fast inference)
 * - Grok (xAI)
 * - OpenAI
 * - Anthropic
 * - Mistral
 * - Together AI
 * - Fireworks AI
 * - Replicate
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

export type ProviderName =
  | "ollama"
  | "openrouter"
  | "groq"
  | "grok"
  | "openai"
  | "anthropic"
  | "mistral"
  | "together"
  | "fireworks"
  | "replicate";

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
  defaultModel: string;
  models: string[];
  enabled: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsVision: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  model: string;
  provider: ProviderName;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ProviderSettings {
  activeProvider: ProviderName;
  activeModel: string;
  providers: Record<ProviderName, Partial<ProviderConfig>>;
}

// ============================================
// Provider Definitions
// ============================================

const PROVIDER_DEFAULTS: Record<ProviderName, ProviderConfig> = {
  ollama: {
    name: "ollama",
    displayName: "Ollama (Local)",
    baseUrl: "http://localhost:11434",
    apiKeyEnv: "", // No API key needed
    defaultModel: "glm-4.7-flash:latest",
    models: ["glm-4.7-flash:latest", "qwen2.5:14b", "llama3:8b", "mistral:7b", "codellama:13b"],
    enabled: true,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  openrouter: {
    name: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-3.5-sonnet",
    models: [
      "anthropic/claude-3.5-sonnet",
      "anthropic/claude-3-opus",
      "openai/gpt-4-turbo",
      "google/gemini-pro-1.5",
      "meta-llama/llama-3-70b-instruct",
    ],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  groq: {
    name: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    defaultModel: "llama-3.1-70b-versatile",
    models: [
      "llama-3.1-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
      "gemma2-9b-it",
    ],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
  },
  grok: {
    name: "grok",
    displayName: "Grok (xAI)",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    defaultModel: "grok-beta",
    models: ["grok-beta", "grok-vision-beta"],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  openai: {
    name: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4-turbo",
    models: ["gpt-4-turbo", "gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  anthropic: {
    name: "anthropic",
    displayName: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-3-5-sonnet-20241022",
    models: [
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
    ],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
  },
  mistral: {
    name: "mistral",
    displayName: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    defaultModel: "mistral-large-latest",
    models: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "codestral-latest",
    ],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
  },
  together: {
    name: "together",
    displayName: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    defaultModel: "meta-llama/Llama-3-70b-chat-hf",
    models: [
      "meta-llama/Llama-3-70b-chat-hf",
      "mistralai/Mixtral-8x22B-Instruct-v0.1",
      "Qwen/Qwen2-72B-Instruct",
    ],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
  },
  fireworks: {
    name: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    defaultModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    models: [
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      "accounts/fireworks/models/mixtral-8x22b-instruct",
    ],
    enabled: false,
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
  },
  replicate: {
    name: "replicate",
    displayName: "Replicate",
    baseUrl: "https://api.replicate.com/v1",
    apiKeyEnv: "REPLICATE_API_TOKEN",
    defaultModel: "meta/llama-2-70b-chat",
    models: ["meta/llama-2-70b-chat", "mistralai/mixtral-8x7b-instruct-v0.1"],
    enabled: false,
    supportsTools: false,
    supportsStreaming: true,
    supportsVision: true,
  },
};

// ============================================
// Provider Manager
// ============================================

export class ProviderManager {
  private settings: ProviderSettings;
  private settingsPath: string;

  constructor(settingsPath?: string) {
    this.settingsPath = settingsPath || path.join(os.homedir(), ".8gent", "providers.json");
    this.settings = this.loadSettings();
  }

  private loadSettings(): ProviderSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, "utf-8");
        const saved = JSON.parse(data) as Partial<ProviderSettings>;
        return {
          activeProvider: saved.activeProvider || "ollama",
          activeModel: saved.activeModel || "glm-4.7-flash:latest",
          providers: { ...this.getDefaultProviders(), ...saved.providers },
        };
      }
    } catch (err) {
      console.warn(`Could not load provider settings: ${err}`);
    }
    return {
      activeProvider: "ollama",
      activeModel: "glm-4.7-flash:latest",
      providers: this.getDefaultProviders(),
    };
  }

  private getDefaultProviders(): Record<ProviderName, Partial<ProviderConfig>> {
    const providers: Record<string, Partial<ProviderConfig>> = {};
    for (const [name, config] of Object.entries(PROVIDER_DEFAULTS)) {
      providers[name] = { enabled: config.enabled };
    }
    return providers as Record<ProviderName, Partial<ProviderConfig>>;
  }

  saveSettings(): void {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
  }

  // ============================================
  // Provider Management
  // ============================================

  getActiveProvider(): ProviderConfig {
    return this.getProvider(this.settings.activeProvider);
  }

  getActiveModel(): string {
    return this.settings.activeModel;
  }

  getProvider(name: ProviderName): ProviderConfig {
    const defaults = PROVIDER_DEFAULTS[name];
    const overrides = this.settings.providers[name] || {};
    return { ...defaults, ...overrides };
  }

  setActiveProvider(name: ProviderName): void {
    if (!PROVIDER_DEFAULTS[name]) {
      throw new Error(`Unknown provider: ${name}`);
    }
    this.settings.activeProvider = name;
    this.settings.activeModel = this.getProvider(name).defaultModel;
    this.saveSettings();
  }

  setActiveModel(model: string): void {
    this.settings.activeModel = model;
    this.saveSettings();
  }

  enableProvider(name: ProviderName, apiKey?: string): void {
    if (!this.settings.providers[name]) {
      this.settings.providers[name] = {};
    }
    this.settings.providers[name].enabled = true;
    if (apiKey) {
      this.settings.providers[name].apiKey = apiKey;
    }
    this.saveSettings();
  }

  disableProvider(name: ProviderName): void {
    if (this.settings.providers[name]) {
      this.settings.providers[name].enabled = false;
      this.saveSettings();
    }
  }

  setApiKey(name: ProviderName, apiKey: string): void {
    if (!this.settings.providers[name]) {
      this.settings.providers[name] = {};
    }
    this.settings.providers[name].apiKey = apiKey;
    this.saveSettings();
  }

  getApiKey(name: ProviderName): string | null {
    const config = this.getProvider(name);
    // Check saved key first
    if (config.apiKey) return config.apiKey;
    // Then environment variable
    if (config.apiKeyEnv && process.env[config.apiKeyEnv]) {
      return process.env[config.apiKeyEnv] || null;
    }
    return null;
  }

  listProviders(): ProviderConfig[] {
    return Object.values(PROVIDER_DEFAULTS).map((p) => this.getProvider(p.name));
  }

  listEnabledProviders(): ProviderConfig[] {
    return this.listProviders().filter((p) => p.enabled || this.getApiKey(p.name));
  }

  // ============================================
  // Chat API
  // ============================================

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const provider = this.getActiveProvider();
    const model = request.model || this.settings.activeModel;

    switch (provider.name) {
      case "ollama":
        return this.chatOllama(request, model);
      case "anthropic":
        return this.chatAnthropic(request, model);
      default:
        // OpenAI-compatible providers
        return this.chatOpenAICompatible(provider, request, model);
    }
  }

  private async chatOllama(request: ChatRequest, model: string): Promise<ChatResponse> {
    const provider = this.getProvider("ollama");

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }

    const response = await fetch(`${provider.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();

    let toolCalls: ToolCall[] | undefined;
    if (data.message?.tool_calls) {
      toolCalls = data.message.tool_calls.map((tc: any, i: number) => ({
        id: `call_${i}`,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      }));
    }

    return {
      content: data.message?.content || "",
      toolCalls,
      model,
      provider: "ollama",
      usage: data.eval_count ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      } : undefined,
    };
  }

  private async chatOpenAICompatible(
    provider: ProviderConfig,
    request: ChatRequest,
    model: string
  ): Promise<ChatResponse> {
    const apiKey = this.getApiKey(provider.name);
    if (!apiKey) {
      throw new Error(`No API key for ${provider.displayName}. Set ${provider.apiKeyEnv} or use /settings`);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    // OpenRouter needs extra headers
    if (provider.name === "openrouter") {
      headers["HTTP-Referer"] = "https://8gent.app";
      headers["X-Title"] = "8gent Code";
    }

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    };

    if (request.tools && request.tools.length > 0 && provider.supportsTools) {
      body.tools = request.tools;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${provider.displayName} error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    let toolCalls: ToolCall[] | undefined;
    if (message?.tool_calls) {
      toolCalls = message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      }));
    }

    return {
      content: message?.content || "",
      toolCalls,
      model,
      provider: provider.name,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
      } : undefined,
    };
  }

  private async chatAnthropic(request: ChatRequest, model: string): Promise<ChatResponse> {
    const provider = this.getProvider("anthropic");
    const apiKey = this.getApiKey("anthropic");
    if (!apiKey) {
      throw new Error(`No API key for Anthropic. Set ANTHROPIC_API_KEY or use /settings`);
    }

    // Convert messages to Anthropic format
    const systemMessage = request.messages.find((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens || 4096,
      messages: otherMessages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const response = await fetch(`${provider.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic error: ${response.status} ${errorText}`);
    }

    const data = await response.json();

    let content = "";
    let toolCalls: ToolCall[] | undefined;

    for (const block of data.content || []) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      content,
      toolCalls,
      model,
      provider: "anthropic",
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens || 0,
        completionTokens: data.usage.output_tokens || 0,
        totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : undefined,
    };
  }
}

// ============================================
// Singleton & Exports
// ============================================

let providerManagerInstance: ProviderManager | null = null;

export function getProviderManager(): ProviderManager {
  if (!providerManagerInstance) {
    providerManagerInstance = new ProviderManager();
  }
  return providerManagerInstance;
}

export function resetProviderManager(): void {
  providerManagerInstance = null;
}

// Export provider names for reference
export const PROVIDER_NAMES: ProviderName[] = [
  "ollama",
  "openrouter",
  "groq",
  "grok",
  "openai",
  "anthropic",
  "mistral",
  "together",
  "fireworks",
  "replicate",
];

export default {
  getProviderManager,
  resetProviderManager,
  PROVIDER_NAMES,
  PROVIDER_DEFAULTS,
};
