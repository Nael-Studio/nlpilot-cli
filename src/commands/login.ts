import { input, password, select } from "@inquirer/prompts";
import kleur from "kleur";
import {
  DEFAULT_MODELS,
  saveCredentials,
  credentialsExist,
  type Provider,
} from "../config.ts";
import { PROVIDER_LABELS } from "../providers.ts";
import { listModels } from "../models.ts";

const CUSTOM_MODEL_VALUE = "__custom__";

async function pickModel(provider: Provider): Promise<string> {
  const catalog = listModels(provider);
  const choices = [
    ...catalog.map((m) => ({
      name: m.description ? `${m.label} — ${m.description}` : m.label,
      value: m.id,
    })),
    { name: "Custom… (enter model id manually)", value: CUSTOM_MODEL_VALUE },
  ];

  const picked = await select<string>({
    message: "Select model:",
    choices,
    default: DEFAULT_MODELS[provider],
  });

  if (picked !== CUSTOM_MODEL_VALUE) return picked;

  return input({
    message: "Enter custom model id:",
    default: DEFAULT_MODELS[provider],
    validate: (v) => (v && v.trim().length > 0 ? true : "Model id cannot be empty"),
  });
}

export async function loginCommand(): Promise<void> {
  if (await credentialsExist()) {
    console.log(
      kleur.yellow(
        "⚠ Credentials already exist. Run `nlpilot logout` first to replace them.",
      ),
    );
    return;
  }

  const providerChoices: { name: string; value: Provider }[] = (
    Object.keys(PROVIDER_LABELS) as Provider[]
  ).map((p) => ({ name: PROVIDER_LABELS[p], value: p }));

  const provider = await select<Provider>({
    message: "Select default provider:",
    choices: providerChoices,
  });

  const apiKey = await password({
    message: "Enter your API key:",
    mask: "•",
    validate: (v) => (v && v.trim().length > 0 ? true : "API key cannot be empty"),
  });

  const useCustomEndpoint = await select<boolean>({
    message: "Use custom endpoint? (e.g., Azure Foundry)",
    choices: [
      { name: "No", value: false },
      { name: "Yes", value: true },
    ],
  });

  let baseUrl: string | undefined;
  if (useCustomEndpoint) {
    baseUrl = await input({
      message: "Enter custom endpoint base URL (e.g., https://your-instance.services.ai.azure.com/anthropic/v1):",
      validate: (v) => {
        if (!v.trim()) return true; // Optional
        try {
          new URL(v);
          return true;
        } catch {
          return "Invalid URL";
        }
      },
    });
    baseUrl = baseUrl.trim() || undefined;
  }

  const model = (await pickModel(provider)).trim();

  const path = await saveCredentials({ 
    provider, 
    apiKey: apiKey.trim(), 
    model,
    ...(baseUrl && { baseUrl }),
  });

  console.log();
  console.log(kleur.green("✓"), `Key stored securely in ${kleur.dim(path)}`);
  console.log(
    kleur.green("✓"),
    `Provider: ${kleur.bold(provider)}  Model: ${kleur.bold(model)}`,
  );
  if (baseUrl) {
    console.log(kleur.green("✓"), `Custom endpoint: ${kleur.dim(baseUrl)}`);
  }
}
