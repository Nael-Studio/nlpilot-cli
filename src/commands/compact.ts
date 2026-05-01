import { generateText, type ModelMessage } from "ai";
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

export async function runAutoCompact(session: Session): Promise<void> {
  if (session.messages.length === 0) return;
  try {
    const transcript = session.messages
      .map((m) => {
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role.toUpperCase()}: ${content}`;
      })
      .join("\n\n");
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
