import kleur from "kleur";
import { resolveCredentials, type Provider } from "../config.ts";
import { getModelCatalog } from "../models.ts";
import { PROVIDER_LABELS } from "../providers.ts";

const VALID_PROVIDERS: Provider[] = ["openai", "anthropic", "google"];

function isProvider(value: string): value is Provider {
  return VALID_PROVIDERS.includes(value as Provider);
}

export async function modelsCommand(providerArg?: string): Promise<void> {
  const modelCatalog = getModelCatalog();
  let providers: Provider[];

  if (providerArg) {
    if (!isProvider(providerArg)) {
      console.error(
        kleur.red("✗"),
        `Unknown provider "${providerArg}". Expected one of: ${VALID_PROVIDERS.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    providers = [providerArg];
  } else {
    providers = VALID_PROVIDERS;
  }

  const creds = await resolveCredentials();
  const activeProvider = creds?.provider;
  const activeModel = creds?.model;

  for (const p of providers) {
    console.log(kleur.bold().magenta(PROVIDER_LABELS[p]));
    for (const m of modelCatalog[p]) {
      const isActive = p === activeProvider && m.id === activeModel;
      const marker = isActive ? kleur.green("●") : " ";
      const label = isActive ? kleur.bold(m.label) : m.label;
      const description = m.description ? kleur.dim(` — ${m.description}`) : "";
      console.log(`  ${marker} ${label}${description}`);
    }
    console.log();
  }

  console.log(
    kleur.dim(
      "Use `nlpilot --model <id>` for a one-off, or set NLPILOT_MODEL to override.",
    ),
  );
}
