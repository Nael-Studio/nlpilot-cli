import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod, unlink, stat } from "node:fs/promises";
import { MODEL_CATALOG } from "./models.ts";

export type Provider = "openai" | "anthropic" | "google";

export interface Credentials {
  provider: Provider;
  apiKey: string;
  model?: string;
}

const CONFIG_DIR = join(homedir(), ".nlpilot");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials");

export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: MODEL_CATALOG.openai[0]!.id,
  anthropic: MODEL_CATALOG.anthropic[0]!.id,
  google: MODEL_CATALOG.google[0]!.id,
};

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
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
