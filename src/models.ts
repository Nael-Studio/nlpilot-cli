import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./config.ts";

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  contextSize?: number; // Maximum context window size in tokens
}

const MODELS_FILE = join(homedir(), ".nlpilot", "models.json");

/**
 * Fallback catalog for development or when the JSON file is not available.
 * This is embedded in the source for backwards compatibility.
 */
const FALLBACK_CATALOG: Record<Provider, ModelOption[]> = {
  openai: [
    {
      id: "gpt-5.5",
      label: "gpt-5.5",
      description: "Flagship · 1M ctx · 64tps · $5/$30 per M",
      contextSize: 1000000,
    },
    {
      id: "gpt-5.5-pro",
      label: "gpt-5.5-pro",
      description: "Heavy reasoning · 1M ctx · $30/$180 per M",
      contextSize: 1000000,
    },
    {
      id: "gpt-5.4",
      label: "gpt-5.4",
      description: "Balanced · 1.1M ctx · 61tps · $2.50/$15 per M",
      contextSize: 1100000,
    },
    {
      id: "gpt-5.4-mini",
      label: "gpt-5.4-mini",
      description: "Fast · 400K ctx · 186tps · $0.75/$4.50 per M",
      contextSize: 400000,
    },
    {
      id: "gpt-5.4-nano",
      label: "gpt-5.4-nano",
      description: "Cheapest · 400K ctx · 26tps · $0.20/$1.25 per M",
      contextSize: 400000,
    },
    {
      id: "gpt-5.4-pro",
      label: "gpt-5.4-pro",
      description: "Heavy reasoning · 1.1M ctx · 68s · $30/$180 per M",
      contextSize: 1100000,
    },
    {
      id: "gpt-5.3-chat",
      label: "gpt-5.3-chat",
      description: "Chat-tuned · 128K ctx · 67tps · $1.75/$14 per M",
      contextSize: 128000,
    },
    {
      id: "gpt-5.3-codex",
      label: "gpt-5.3-codex",
      description: "Code-tuned · 400K ctx · 49tps · $1.75/$14 per M",
      contextSize: 400000,
    },
    {
      id: "gpt-5.2-codex",
      label: "gpt-5.2-codex",
      description: "Code-tuned · 400K ctx · 119tps · $1.75/$14 per M",
      contextSize: 400000,
    },
    {
      id: "gpt-5.2",
      label: "gpt-5.2",
      description: "Previous-gen · 400K ctx · 68tps · $1.75/$14 per M",
      contextSize: 400000,
    },
  ],
  anthropic: [
    {
      id: "claude-opus-4.7",
      label: "claude-opus-4.7",
      description: "Top quality · 1M ctx · 70tps · $5/$25 per M",
      contextSize: 1000000,
    },
    {
      id: "claude-sonnet-4.6",
      label: "claude-sonnet-4.6",
      description: "Balanced flagship · 1M ctx · 54tps · $3/$15 per M",
      contextSize: 1000000,
    },
    {
      id: "claude-opus-4-6",
      label: "claude-opus-4.6",
      description: "High quality · 1M ctx · 58tps · $5/$25 per M",
      contextSize: 1000000,
    },
    {
      id: "claude-sonnet-4.5",
      label: "claude-sonnet-4.5",
      description: "Balanced · 1M ctx · 60tps · $3/$15 per M",
      contextSize: 1000000,
    },
    {
      id: "claude-opus-4-5",
      label: "claude-opus-4.5",
      description: "High quality · 200K ctx · 51tps · $5/$25 per M",
      contextSize: 200000,
    },
    {
      id: "claude-haiku-4.5",
      label: "claude-haiku-4.5",
      description: "Fast & cheap · 200K ctx · 123tps · $1/$5 per M",
      contextSize: 200000,
    },
    {
      id: "claude-sonnet-4",
      label: "claude-sonnet-4",
      description: "Previous Sonnet · 1M ctx · 66tps · $3/$15 per M",
      contextSize: 1000000,
    },
    {
      id: "claude-opus-4-1",
      label: "claude-opus-4.1",
      description: "Heavy reasoning · 200K ctx · 44tps · $15/$75 per M",
      contextSize: 200000,
    },
    {
      id: "claude-opus-4",
      label: "claude-opus-4",
      description: "Previous Opus · 200K ctx · 45tps · $15/$75 per M",
      contextSize: 200000,
    },
    {
      id: "claude-3-haiku",
      label: "claude-3-haiku",
      description: "Cheapest · 200K ctx · 149tps · $0.25/$1.25 per M",
      contextSize: 200000,
    },
  ],
  google: [
    {
      id: "gemini-2.5-pro",
      label: "gemini-2.5-pro",
      description: "Flagship reasoning",
      contextSize: 1000000,
    },
    {
      id: "gemini-2.5-flash",
      label: "gemini-2.5-flash",
      description: "Fast multimodal",
      contextSize: 1000000,
    },
    {
      id: "gemini-2.5-flash-lite",
      label: "gemini-2.5-flash-lite",
      description: "Cheapest option",
      contextSize: 128000,
    },
  ],
};

let cachedCatalog: Record<Provider, ModelOption[]> | null = null;

/**
 * Loads the model catalog from the JSON file, falling back to the embedded
 * catalog if the file doesn't exist or fails to load.
 */
async function loadModelCatalog(): Promise<Record<Provider, ModelOption[]>> {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  try {
    const raw = await readFile(MODELS_FILE, "utf8");
    cachedCatalog = JSON.parse(raw) as Record<Provider, ModelOption[]>;
    return cachedCatalog;
  } catch {
    // Fall back to embedded catalog if JSON file not found or invalid
    cachedCatalog = FALLBACK_CATALOG;
    return cachedCatalog;
  }
}

/**
 * Gets the model catalog synchronously. Loads from cache or returns fallback.
 * For async loading with guaranteed file read, use loadModelCatalog().
 */
export function getModelCatalog(): Record<Provider, ModelOption[]> {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  // Return fallback for synchronous access (will be replaced once loaded)
  return FALLBACK_CATALOG;
}

/**
 * Pre-load the model catalog from disk.
 */
export async function initializeModelCatalog(): Promise<void> {
  await loadModelCatalog();
}

/**
 * The curated list of well-known models per provider. Loads from
 * ~/.nlpilot/models.json with fallback to embedded catalog.
 * Use getModelCatalog() or await initializeModelCatalog() for best results.
 */
export const MODEL_CATALOG: Record<Provider, ModelOption[]> = FALLBACK_CATALOG;

export function listModels(provider: Provider): ModelOption[] {
  return getModelCatalog()[provider];
}
