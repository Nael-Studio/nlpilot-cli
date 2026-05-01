import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile, chmod, unlink, stat } from "node:fs/promises";
import { getModelCatalog, initializeModelCatalog } from "./models.ts";

export type Provider = "openai" | "anthropic" | "google";

export interface Credentials {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string; // Custom endpoint base URL (e.g., for Azure Foundry)
}

const CONFIG_DIR = join(homedir(), ".nlpilot");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials");
const MODELS_FILE = join(CONFIG_DIR, "models.json");

/**
 * Gets the default models for each provider.
 * Loads from the model catalog with fallback to embedded defaults.
 */
export function getDefaultModels(): Record<Provider, string> {
  const catalog = getModelCatalog();
  return {
    openai: catalog.openai[0]?.id ?? "gpt-5.5",
    anthropic: catalog.anthropic[0]?.id ?? "claude-opus-4.7",
    google: catalog.google[0]?.id ?? "gemini-2.5-pro",
  };
}

export const DEFAULT_MODELS: Record<Provider, string> = getDefaultModels();

/**
 * Embedded models catalog for initialization. Used to create models.json
 * in the config directory during setup.
 */
const EMBEDDED_MODELS = {
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

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  
  // Ensure models.json exists in config directory
  try {
    await stat(MODELS_FILE);
  } catch {
    // File doesn't exist, create it with default models
    const data = JSON.stringify(EMBEDDED_MODELS, null, 2);
    await writeFile(MODELS_FILE, data, { encoding: "utf8", mode: 0o644 });
  }
  
  // Initialize the model catalog from the file
  await initializeModelCatalog();
}

export async function saveCredentials(creds: Credentials): Promise<string> {
  await ensureConfigDir();
  const data = JSON.stringify(creds, null, 2);
  await writeFile(CREDENTIALS_FILE, data, { encoding: "utf8", mode: 0o600 });
  await chmod(CREDENTIALS_FILE, 0o600);
  return CREDENTIALS_FILE;
}

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf8");
    return JSON.parse(raw) as Credentials;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function clearCredentials(): Promise<boolean> {
  try {
    await unlink(CREDENTIALS_FILE);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function credentialsExist(): Promise<boolean> {
  try {
    await stat(CREDENTIALS_FILE);
    return true;
  } catch {
    return false;
  }
}

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

/**
 * Resolves the active credentials, applying environment overrides.
 * Precedence:
 *   - NLPILOT_API_KEY env var (provider/model from env or stored file)
 *   - stored credentials file
 */
export async function resolveCredentials(): Promise<Credentials | null> {
  const stored = await loadCredentials();
  const envKey = process.env.NLPILOT_API_KEY;
  const envProvider = process.env.NLPILOT_PROVIDER as Provider | undefined;
  const envModel = process.env.NLPILOT_MODEL;

  if (envKey) {
    const provider = envProvider ?? stored?.provider ?? "openai";
    return {
      provider,
      apiKey: envKey,
      model: envModel ?? stored?.model ?? DEFAULT_MODELS[provider],
    };
  }

  if (!stored) return null;

  return {
    ...stored,
    model: envModel ?? stored.model ?? DEFAULT_MODELS[stored.provider],
  };
}
