import { homedir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile, chmod, unlink, stat } from "node:fs/promises";
import { getModelCatalog, initializeModelCatalog } from "./models.ts";
import sourceModels from "../models.json" with { type: "json" };

export type Provider = "openai" | "anthropic" | "google" | "deepseek" | "moonshotai";

export interface Credentials {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string; // Custom endpoint base URL (e.g., for Azure Foundry)
}

const CONFIG_DIR = join(homedir(), ".nlpilot");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials");
const MODELS_FILE = join(CONFIG_DIR, "models.json");
const SOURCE_MODELS = sourceModels as Record<
  Provider,
  Array<{
    id: string;
    label: string;
    description?: string;
    contextSize?: number;
  }>
>;

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
    deepseek: catalog.deepseek?.[0]?.id ?? "deepseek-v4-pro",
    moonshotai: catalog.moonshotai?.[0]?.id ?? "kimi-k2.6",
  };
}

export const DEFAULT_MODELS: Record<Provider, string> = getDefaultModels();

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });

  // Keep ~/.nlpilot/models.json in sync with the packaged model catalog.
  const data = JSON.stringify(SOURCE_MODELS, null, 2) + "\n";
  try {
    const existing = await readFile(MODELS_FILE, "utf8");
    if (existing !== data) {
      await writeFile(MODELS_FILE, data, { encoding: "utf8", mode: 0o644 });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
