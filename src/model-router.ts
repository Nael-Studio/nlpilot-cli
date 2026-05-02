import type { Credentials, Provider } from "./config.ts";
import { DEFAULT_MODELS } from "./config.ts";
import { getModelCatalog } from "./models.ts";

export type TaskClass = "cheap" | "balanced" | "reasoning";

export interface ModelRoute {
  taskClass: TaskClass;
  modelName: string;
  reason: string;
}

const ROUTE_MODEL_CANDIDATES: Record<Provider, Record<TaskClass, string[]>> = {
  openai: {
    cheap: ["gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.3-chat"],
    balanced: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
    reasoning: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4-pro"],
  },
  anthropic: {
    cheap: ["claude-3-haiku", "claude-haiku-4.5"],
    balanced: ["claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4"],
    reasoning: ["claude-opus-4.7", "claude-opus-4-6", "claude-opus-4-1"],
  },
  google: {
    cheap: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    balanced: ["gemini-2.5-flash", "gemini-2.5-pro"],
    reasoning: ["gemini-2.5-pro"],
  },
  deepseek: {
    cheap: ["deepseek-v4-flash", "deepseek-v3.2"],
    balanced: ["deepseek-v4-flash", "deepseek-v4-pro"],
    reasoning: ["deepseek-v4-pro", "deepseek-v3.2-thinking"],
  },
  moonshotai: {
    cheap: ["kimi-k2.6"],
    balanced: ["kimi-k2.6"],
    reasoning: ["kimi-k2.6"],
  },
};

export function classifyTask(prompt: string, mode: "ask" | "plan" | "autopilot" = "ask"): TaskClass {
  const text = prompt.toLowerCase();
  const compact = text.replace(/\s+/g, " ").trim();

  if (mode === "plan") return "reasoning";

  if (
    /\b(?:architecture|architect|design|root cause|race condition|deadlock|security|vulnerability|threat model|data loss|migration|performance|memory leak|flaky|hard bug|complex|investigate|diagnose|debug|review)\b/.test(compact) ||
    /\b(?:why does|why is|what causes|find the bug|failing tests?|test failure)\b/.test(compact)
  ) {
    return "reasoning";
  }

  if (
    compact.length <= 180 &&
    /\b(?:help|usage|models?|list|show|where is|find|grep|search|locate|tree|structure|files?|folders?|rename|replace|format|convert|summari[sz]e|explain|shorten)\b/.test(compact)
  ) {
    return "cheap";
  }

  if (
    /\b(?:implement|build|add|fix|refactor|rewrite|modify|change|update|create|delete|remove)\b/.test(compact) ||
    /(?:^|\s)(?:src|lib|test|tests|docs)\//.test(compact) ||
    /\.[cm]?[tj]sx?\b/.test(compact)
  ) {
    return "balanced";
  }

  if (
    compact.length <= 240 ||
    /\b(?:help|usage|commands?|models?|list|show|where is|find|grep|search|locate|tree|structure|files?|folders?|summari[sz]e|explain|what is|how do i)\b/.test(compact)
  ) {
    return "cheap";
  }

  return "balanced";
}

export function resolveRoutedModel(
  creds: Credentials,
  prompt: string,
  mode: "ask" | "plan" | "autopilot" = "ask",
): ModelRoute {
  const taskClass = classifyTask(prompt, mode);
  const configured = creds.model ?? DEFAULT_MODELS[creds.provider];
  const modelName = pickModelForClass(creds.provider, taskClass, configured);
  return {
    taskClass,
    modelName,
    reason: `${taskClass} task`,
  };
}

function pickModelForClass(
  provider: Provider,
  taskClass: TaskClass,
  configuredModel: string,
): string {
  if (taskClass === "reasoning") return configuredModel;

  const catalog = getModelCatalog()[provider] ?? [];
  const available = new Set(catalog.map((m) => m.id));
  const candidates = ROUTE_MODEL_CANDIDATES[provider]?.[taskClass] ?? [];
  return candidates.find((id) => available.has(id)) ?? configuredModel;
}
