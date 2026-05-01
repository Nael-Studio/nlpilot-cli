/**
 * Token tracking utilities for conversation context management.
 * Provides estimation of token usage based on text length and
 * context window tracking for the active model.
 */

import { getModelCatalog } from "../models.ts";
import type { Provider } from "../config.ts";

/**
 * Estimates token count from text.
 * Uses a conservative 4-chars-per-token ratio as baseline.
 * For English text, this typically gives ±10% accuracy.
 */
export function estimateTokens(text: string): number {
  // Conservative estimate: ~1 token per 4 characters
  // (English average is 4-5 chars/token, code can be 2-3)
  return Math.ceil(text.length / 4);
}

/**
 * Gets the context size (in tokens) for a given model.
 * Falls back to a default if the model is not found.
 */
export function getContextSize(
  provider: Provider,
  modelId: string,
): number | undefined {
  const catalog = getModelCatalog();
  const models = catalog[provider];
  if (!models) return undefined;

  const model = models.find((m: { id: string }) => m.id === modelId);
  return model?.contextSize;
}

/**
 * Calculates context usage statistics.
 */
export interface ContextStats {
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  contextSize: number | undefined;
  percentageUsed: number | undefined;
  isApproachingLimit: boolean; // true if > 90% used
  warningThreshold: number; // 90% of context size
  isActual: boolean; // true if using real API counts, false if estimated
}

export function getContextStats(
  inputTokens: number,
  outputTokens: number,
  provider: Provider,
  modelId: string,
  isActual: boolean = true,
): ContextStats {
  const tokensUsed = inputTokens + outputTokens;
  const contextSize = getContextSize(provider, modelId);
  
  if (!contextSize) {
    return {
      tokensUsed,
      inputTokens,
      outputTokens,
      contextSize: undefined,
      percentageUsed: undefined,
      isApproachingLimit: false,
      warningThreshold: 0,
      isActual,
    };
  }

  const warningThreshold = contextSize * 0.9;
  const percentageUsed = (tokensUsed / contextSize) * 100;

  return {
    tokensUsed,
    inputTokens,
    outputTokens,
    contextSize,
    percentageUsed,
    isApproachingLimit: tokensUsed > warningThreshold,
    warningThreshold: Math.ceil(warningThreshold),
    isActual,
  };
}

/**
 * Formats context stats for terminal display.
 */
export function formatContextStats(stats: ContextStats): string {
  const actualLabel = stats.isActual ? "" : " (estimated)";
  
  if (!stats.contextSize) {
    // Context size unknown, just show tokens
    return `${stats.tokensUsed.toLocaleString()} tokens${actualLabel}\n  Input: ${stats.inputTokens.toLocaleString()} · Output: ${stats.outputTokens.toLocaleString()}`;
  }

  const contextSizeStr = (stats.contextSize / 1000000).toFixed(1);
  const percentStr = stats.percentageUsed?.toFixed(1) ?? "?";
  const bar = createContextBar(stats.percentageUsed ?? 0);
  
  const statusIcon = stats.isApproachingLimit ? "⚠ " : "  ";
  
  return (
    `${statusIcon}${stats.tokensUsed.toLocaleString()} / ${stats.contextSize.toLocaleString()} tokens (${percentStr}%)${actualLabel}\n` +
    `  Context: ${bar} ${contextSizeStr}M\n` +
    `  Input: ${stats.inputTokens.toLocaleString()} · Output: ${stats.outputTokens.toLocaleString()}`
  );
}

/**
 * Creates a simple ASCII bar chart for context usage.
 */
function createContextBar(percentage: number): string {
  const filled = Math.round(percentage / 5); // 20 chars = 100%
  const empty = 20 - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  
  if (percentage > 90) {
    return `\x1b[31m[${bar}]\x1b[0m`; // Red for warning
  } else if (percentage > 70) {
    return `\x1b[33m[${bar}]\x1b[0m`; // Yellow for caution
  }
  return `[${bar}]`; // Default
}
