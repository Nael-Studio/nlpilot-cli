import type { LanguageModel, ModelMessage, ToolResultPart } from "ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Credentials } from "./config.ts";
import { loadCustomAgents, loadSkills, type CustomAgent, type Skill } from "./customization.ts";
import { loadHooks, type HooksConfig } from "./hooks.ts";

export type Mode = "ask" | "plan" | "autopilot";
export type Theme = "default" | "dim" | "high-contrast";

export interface FileChange {
  path: string;
  before: string | null; // null if file did not exist (creation)
  after: string;
  tool: "edit" | "create";
  turn: number;
  timestamp: number;
}

export interface Session {
  id: string;
  name?: string;
  createdAt: number;
  creds: Credentials;
  modelName: string;
  languageModel: LanguageModel;
  messages: ModelMessage[];
  mode: Mode;
  theme: Theme;
  turn: number;
  fileChanges: FileChange[];
  lastAssistantText: string;
  instructions: LoadedInstructions;
  agents: CustomAgent[];
  skills: Skill[];
  hooks: HooksConfig;
  enableReasoningSummaries?: boolean;
  additionalMcpConfig?: string;
  cumulativeInputTokens: number; // Actual tokens from API
  cumulativeOutputTokens: number; // Actual tokens from API
  /** Compact list of source files in cwd, injected at session start to avoid discovery tool calls. */
  sourceFiles?: string[];
}

export interface LoadedInstruction {
  path: string;
  content: string;
}

export interface LoadedInstructions {
  files: LoadedInstruction[];
}

const INSTRUCTION_FILENAMES = [
  join(".nlpilot", "instructions.md"),
  "AGENTS.md",
  "INSTRUCTIONS.md",
];

/**
 * Load project-level instruction files from well-known paths.
 *
 * Searches for `.nlpilot/instructions.md`, `AGENTS.md`, and `INSTRUCTIONS.md`
 * in the given working directory.
 *
 * @param cwd - Project root to search in. Defaults to `process.cwd()`.
 * @returns A collection of loaded instruction files.
 */
export async function loadInstructions(cwd: string = process.cwd()): Promise<LoadedInstructions> {
  const files: LoadedInstruction[] = [];
  for (const rel of INSTRUCTION_FILENAMES) {
    const p = join(cwd, rel);
    try {
      const content = await readFile(p, "utf8");
      files.push({ path: p, content });
    } catch {
      // ignore missing
    }
  }
  return { files };
}

/**
 * Load all project customization assets in parallel.
 *
 * @param cwd - Project root to search in. Defaults to `process.cwd()`.
 * @returns An object containing instructions, custom agents, skills, and hooks.
 */
export async function loadCustomization(cwd: string = process.cwd()): Promise<{
  instructions: LoadedInstructions;
  agents: CustomAgent[];
  skills: Skill[];
  hooks: HooksConfig;
}> {
  const [instructions, agents, skills, hooks] = await Promise.all([
    loadInstructions(cwd),
    loadCustomAgents(cwd),
    loadSkills(cwd),
    loadHooks(cwd),
  ]);
  return { instructions, agents, skills, hooks };
}

/**
 * Returns a copy of messages with large tool results from older turns compressed.
 * Keeps the last `keepFullTurns` assistant turns intact; trims earlier tool results
 * that exceed `maxResultChars` to a short stub. This prevents verbose file reads
 * and bash output from ballooning the context on every subsequent turn.
 */
export function trimMessagesForSending(
  messages: ModelMessage[],
  keepFullTurns = 1,
  maxResultChars = 800,
  /** Results shorter than this are never trimmed (default: 200 chars). */
  minCharsBefore = 200,
): ModelMessage[] {
  // Count assistant turns from the end to find the cutoff index
  let assistantTurnsSeen = 0;
  let cutoffIndex = messages.length; // everything before this index gets trimmed
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      assistantTurnsSeen++;
      if (assistantTurnsSeen >= keepFullTurns) {
        cutoffIndex = i;
        break;
      }
    }
  }

  return messages.map((msg, idx) => {
    if (idx >= cutoffIndex) return msg; // keep recent messages intact
    if (msg.role !== "tool") return msg; // only compress tool result messages

    const parts = msg.content as ToolResultPart[];
    const compressedParts = parts.map((part) => {
      const resultStr =
        typeof part.output === "string" ? part.output : JSON.stringify(part.output);

      // Never trim small results — they're already compact.
      if (resultStr.length < minCharsBefore) return part;

      // Adaptive cap: give error messages more breathing room since errors
      // are usually dense and important for diagnosis.
      const hasError = resultStr.includes("Error") || resultStr.includes("error");
      const cap = hasError ? Math.max(maxResultChars, 1_500) : maxResultChars;

      if (resultStr.length <= cap) return part;
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${resultStr.slice(0, cap)}\n[output trimmed — ${resultStr.length - cap} chars]`,
        },
      };
    });
    return { ...msg, content: compressedParts };
  });
}

/**
 * Assemble the full system prompt for the current session.
 *
 * Includes the base assistant persona, context-efficiency rules, mode guidance,
 * project instructions, available skills, and source file tree.
 *
 * @param session - The active session containing customization and state.
 * @returns The complete system prompt string.
 */
export function buildSystemPrompt(session: Session): string {
  const base =
    "You are nlpilot, a helpful AI coding assistant running in a terminal.\n" +
    "Tools available: view (read file lines), bash, edit, create, grep (also does file discovery via filenamesOnly:true), web_fetch, plus any registered MCP tools.\n\n" +
    "CONTEXT EFFICIENCY — follow strictly, every violation costs real money:\n" +
    "1. The file tree below already tells you every file that exists. NEVER run discovery calls to find files.\n" +
    "2. If the user's request can be answered with a clarifying question (e.g. 'the loader already exists in src/ui/loader.ts — which command should it be added to?'), ask first WITHOUT reading any files.\n" +
    "3. For 'add X to multiple files' tasks: use `grep` to find ONE existing usage of X (with contextLines:3), then apply the same pattern to other files via `edit`. Do NOT read every target file first.\n" +
    "4. For targeted edits: use `grep` with a precise pattern to find the exact insertion point (contextLines:5), then `edit` directly. Only call `view` if grep cannot give you enough context.\n" +
    "5. `view` is a last resort. If you use it, read at least 150 lines in one call. NEVER view the same file twice in one turn.\n" +
    "6. Do NOT read a file before or after an edit to verify it — trust the edit succeeded.\n" +
    "BANNED PATTERNS — never use these:\n" +
    "- `bash find`, `bash ls`, `bash ls -la` → file list is already in the system prompt.\n" +
    "- `bash sed -n`, `bash cat FILE`, `bash head -N FILE` → use the `view` tool instead.\n" +
    "- `bash wc -l`, `bash cat FILE | grep` → use the `grep` tool directly.\n" +
    "- Reading files 'to understand the pattern' before making an edit — use grep with contextLines instead.\n" +
    "- Reading README, docs, or large markdown files unless explicitly asked about them.\n" +
    "For open-ended questions about the project, answer from your training knowledge. Only use tools when making a concrete code change.\n\n" +
    "Be concise.";

  let modeNote = "\n\nMODE: ask. Ask the user before taking non-trivial actions.";
  if (session.mode === "plan") {
    modeNote =
      "\n\nMODE: plan. Before invoking any mutating tool, produce a short numbered plan and ask the user to confirm. Prefer read-only tools (view, glob, grep, web_fetch) until the plan is confirmed.";
  } else if (session.mode === "autopilot") {
    modeNote =
      "\n\nMODE: autopilot. The user has authorized you to run all tools without per-call approval. Still avoid destructive operations unless clearly requested.";
  }

  const instrBlock =
    session.instructions.files.length > 0
      ? "\n\n--- Project instructions ---\n" +
        session.instructions.files
          .map((f) => {
            const estTokens = Math.ceil(f.content.length / 4);
            const MAX_INSTRUCTION_CHARS = 60_000; // ~15 k tokens
            if (f.content.length > MAX_INSTRUCTION_CHARS) {
              return (
                `# ${f.path}\n` +
                `[Warning: file is ~${estTokens.toLocaleString()} estimated tokens — too large. Showing first portion only.]\n` +
                f.content.slice(0, MAX_INSTRUCTION_CHARS) +
                "\n…"
              );
            }
            return `# ${f.path}\n${f.content}`;
          })
          .join("\n\n")
      : "";

  const skillsBlock =
    session.skills.length > 0
      ? "\n\n--- Available skills (invoke via /SKILL-NAME) ---\n" +
        session.skills
          .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`)
          .join("\n")
      : "";

  const agentsBlock =
    session.agents.length > 0
      ? "\n\n--- Custom agents available ---\n" +
        session.agents
          .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`)
          .join("\n")
      : "";

  const fileTreeBlock =
    session.sourceFiles && session.sourceFiles.length > 0
      ? "\n\n--- Project files (COMPLETE list — do not run any discovery commands) ---\n" +
        session.sourceFiles.join("\n") +
        "\n--- End of file list. You know all files. Skip discovery entirely. ---"
      : "";

  return base + modeNote + instrBlock + skillsBlock + agentsBlock + fileTreeBlock;
}
