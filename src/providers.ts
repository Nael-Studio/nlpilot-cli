import { createGateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import type { Credentials, Provider } from "./config.ts";
import { DEFAULT_MODELS } from "./config.ts";

export function getModel(creds: Credentials, modelOverride?: string): LanguageModel {
  const modelName = modelOverride ?? creds.model ?? DEFAULT_MODELS[creds.provider];
  const gateway = createGateway({ apiKey: creds.apiKey });
  // The AI Gateway addresses models as `<provider>/<model-id>`.
  // If the caller already passed a slash-qualified id, trust it; otherwise
  // prefix with the configured provider.
  const qualified = modelName.includes("/")
    ? modelName
    : `${creds.provider}/${modelName}`;
  return gateway(qualified);
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};
