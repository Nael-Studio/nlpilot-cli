import { generateText, type ModelMessage, type ToolModelMessage } from "ai";
import kleur from "kleur";
import type { Session } from "../session.ts";

export function estimateTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    total += Math.ceil(content.length / 4);
  }
  return total;
}

/** Max chars kept per tool result when building the compact transcript. */
const COMPACT_TOOL_RESULT_CAP = 400;

/**
 * Serialise messages into a compact transcript for summarization.
 * Tool results (file reads, bash output) are truncated so the summarizer
 * call itself doesn't reproduce the full 180k context.
 */
export function buildCompactTranscript(messages: ModelMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") {
        const parts = (m as ToolModelMessage).content
          .filter((p) => p.type === "tool-result")
          .map((p) => {
            const raw = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
            const trimmed = raw.length > COMPACT_TOOL_RESULT_CAP
              ? raw.slice(0, COMPACT_TOOL_RESULT_CAP) + `…[+${raw.length - COMPACT_TOOL_RESULT_CAP} chars]`
              : raw;
            return `[tool:${p.toolName}] ${trimmed}`;
          });
        return `TOOL: ${parts.join("\n")}`;
      }
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${m.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

export async function runAutoCompact(session: Session): Promise<void> {
  if (session.messages.length === 0) return;
  try {
    const transcript = buildCompactTranscript(session.messages);
    const result = await generateText({
      model: session.languageModel,
      system:
        "You are a conversation summarizer. Produce a concise but information-dense summary. Preserve decisions, file paths touched, and open TODOs. Do not invent details.",
      prompt: `Summarize the following conversation:\n\n${transcript}`,
    });
    const summary = result.text.trim();
    session.messages = [
      { role: "user", content: `Summary of prior conversation:\n${summary}` },
      { role: "assistant", content: "Acknowledged. Continuing from this summary." },
    ];
    // Reset cumulative token counts to reflect the compacted state.
    // Use the actual usage from the summarization call as the new baseline.
    session.cumulativeInputTokens = result.usage.inputTokens ?? 0;
    session.cumulativeOutputTokens = result.usage.outputTokens ?? 0;
    console.log(kleur.green("✓"), "Auto-compacted conversation");
  } catch (err) {
    console.error(
      kleur.red("✗"),
      "Auto-compact failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
