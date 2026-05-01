import { createGateway } from "@ai-sdk/gateway";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Credentials, Provider } from "./config.ts";
import { DEFAULT_MODELS } from "./config.ts";

/** Infer the provider from a model name prefix when no slash qualifier is present. */
function inferProvider(modelName: string, fallback: Provider): Provider {
  if (modelName.startsWith("gpt-") || modelName.startsWith("o1") || modelName.startsWith("o3")) {
    return "openai";
  }
  if (modelName.startsWith("claude-")) {
    return "anthropic";
  }
  if (modelName.startsWith("gemini-") || modelName.startsWith("models/gemini")) {
    return "google";
  }
  return fallback;
}

export function getModel(creds: Credentials, modelOverride?: string): LanguageModel {
  const modelName = modelOverride ?? creds.model ?? DEFAULT_MODELS[creds.provider];

  // Handle custom baseUrl (e.g., Azure Foundry)
  if (creds.baseUrl) {
    if (creds.provider === "anthropic") {
      const client = createAnthropic({
        apiKey: creds.apiKey,
        baseURL: creds.baseUrl,
      });
      return client(modelName);
    }
    // OpenAI-compatible endpoint (Azure Foundry, etc.) — use baseUrl directly
    // so prompt caching and Azure-specific headers work correctly.
    const client = createOpenAI({
      apiKey: creds.apiKey,
      baseURL: creds.baseUrl,
    });
    return client(modelName);
  }

  // Use gateway for standard endpoints
  const gateway = createGateway({ apiKey: creds.apiKey });
  // The AI Gateway addresses models as `<provider>/<model-id>`.
  // If the caller already passed a slash-qualified id, trust it; otherwise
  // infer the provider from the model name prefix (so e.g. gpt-* always
  // routes to openai regardless of which provider is stored in credentials).
  const qualified = modelName.includes("/")
    ? modelName
    : `${inferProvider(modelName, creds.provider)}/${modelName}`;
  return gateway(qualified);
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};
