import type { Provider } from "./config.ts";

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * Curated list of well-known models per provider. The `id` is the value
 * passed to the Vercel AI SDK provider factory. Users can also enter a
 * custom model id at login time.
 */
export const MODEL_CATALOG: Record<Provider, ModelOption[]> = {
  openai: [
    {
      id: "gpt-5.5",
      label: "gpt-5.5",
      description: "Flagship · 1M ctx · 64tps · $5/$30 per M",
    },
    {
      id: "gpt-5.5-pro",
      label: "gpt-5.5-pro",
      description: "Heavy reasoning · 1M ctx · $30/$180 per M",
    },
    {
      id: "gpt-5.4",
      label: "gpt-5.4",
      description: "Balanced · 1.1M ctx · 61tps · $2.50/$15 per M",
    },
    {
      id: "gpt-5.4-mini",
      label: "gpt-5.4-mini",
      description: "Fast · 400K ctx · 186tps · $0.75/$4.50 per M",
    },
    {
      id: "gpt-5.4-nano",
      label: "gpt-5.4-nano",
      description: "Cheapest · 400K ctx · 26tps · $0.20/$1.25 per M",
    },
    {
      id: "gpt-5.4-pro",
      label: "gpt-5.4-pro",
      description: "Heavy reasoning · 1.1M ctx · 68s · $30/$180 per M",
    },
    {
      id: "gpt-5.3-chat",
      label: "gpt-5.3-chat",
      description: "Chat-tuned · 128K ctx · 67tps · $1.75/$14 per M",
    },
    {
      id: "gpt-5.3-codex",
      label: "gpt-5.3-codex",
      description: "Code-tuned · 400K ctx · 49tps · $1.75/$14 per M",
    },
    {
      id: "gpt-5.2-codex",
      label: "gpt-5.2-codex",
      description: "Code-tuned · 400K ctx · 119tps · $1.75/$14 per M",
    },
    {
      id: "gpt-5.2",
      label: "gpt-5.2",
      description: "Previous-gen · 400K ctx · 68tps · $1.75/$14 per M",
    },
  ],
  anthropic: [
    {
      id: "claude-opus-4.7",
      label: "claude-opus-4.7",
      description: "Top quality · 1M ctx · 70tps · $5/$25 per M",
    },
    {
      id: "claude-sonnet-4.6",
      label: "claude-sonnet-4.6",
      description: "Balanced flagship · 1M ctx · 54tps · $3/$15 per M",
    },
    {
      id: "claude-opus-4-6",
      label: "claude-opus-4.6",
      description: "High quality · 1M ctx · 58tps · $5/$25 per M",
    },
    {
      id: "claude-sonnet-4.5",
      label: "claude-sonnet-4.5",
      description: "Balanced · 1M ctx · 60tps · $3/$15 per M",
    },
    {
      id: "claude-opus-4-5",
      label: "claude-opus-4.5",
      description: "High quality · 200K ctx · 51tps · $5/$25 per M",
    },
    {
      id: "claude-haiku-4.5",
      label: "claude-haiku-4.5",
      description: "Fast & cheap · 200K ctx · 123tps · $1/$5 per M",
    },
    {
      id: "claude-sonnet-4",
      label: "claude-sonnet-4",
      description: "Previous Sonnet · 1M ctx · 66tps · $3/$15 per M",
    },
    {
      id: "claude-opus-4-1",
      label: "claude-opus-4.1",
      description: "Heavy reasoning · 200K ctx · 44tps · $15/$75 per M",
    },
    {
      id: "claude-opus-4",
      label: "claude-opus-4",
      description: "Previous Opus · 200K ctx · 45tps · $15/$75 per M",
    },
    {
      id: "claude-3-haiku",
      label: "claude-3-haiku",
      description: "Cheapest · 200K ctx · 149tps · $0.25/$1.25 per M",
    },
  ],
  google: [
    {
      id: "gemini-2.5-pro",
      label: "gemini-2.5-pro",
      description: "Flagship reasoning",
    },
    {
      id: "gemini-2.5-flash",
      label: "gemini-2.5-flash",
      description: "Fast multimodal",
    },
    {
      id: "gemini-2.5-flash-lite",
      label: "gemini-2.5-flash-lite",
      description: "Cheapest option",
    },
  ],
};

export function listModels(provider: Provider): ModelOption[] {
  return MODEL_CATALOG[provider];
}
