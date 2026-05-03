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
  /** Compact source-file snapshot injected into the system prompt. */
  sourceFiles?: string[];
  /** Directory-level summary used instead of a long raw file tree. */
  sourceFileSummary?: string[];
  /** Number of discovered source files omitted from the compact prompt snapshot. */
  sourceFilesOmitted?: number;
}

export interface LoadedInstruction {
  path: string;
  content: string;
}

export interface LoadedInstructions {
  files: LoadedInstruction[];
}

export interface SystemPromptOptions {
  /**
   * Latest user request. Used to decide whether optional project context is
   * worth spending tokens on for this turn.
   */
  latestUserMessage?: string;
  includeInstructions?: boolean;
  includeSkills?: boolean;
  includeAgents?: boolean;
  includeSourceFiles?: boolean;
}

const INSTRUCTION_FILENAMES = [
  join(".nlpilot", "instructions.md"),
  "AGENTS.md",
  "INSTRUCTIONS.md",
];

function latestUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  }
  return "";
}

function looksProjectRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /(?:^|\s|[`"'(])(?:src|docs|test|tests|lib|bin|config)\//.test(lower) ||
    /\.[cm]?[tj]sx?\b|\.json\b|\.md\b|package\.json|tsconfig/.test(lower) ||
    /\b(?:code|repo|repository|file|files|function|class|module|command|cli|bug|fix|implement|refactor|review|test|typecheck|build|readme|docs|mcp|hook|session|token|prompt|tool)\b/.test(lower)
  );
}

function wantsRepoStructure(text: string): boolean {
  return /\b(?:tree|structure|layout|files?|folders?|directories|repo map|codebase map|where is|find file|list files?)\b/i.test(text);
}

function wantsSkills(text: string): boolean {
  return /(?:^|\s)\/?skills?\b/i.test(text);
}

function wantsAgents(text: string): boolean {
  return /(?:^|\s)\/?agents?\b/i.test(text);
}

function resolvePromptOptions(
  session: Session,
  options: SystemPromptOptions = {},
): Required<SystemPromptOptions> {
  const latestUserMessage = options.latestUserMessage ?? latestUserText(session.messages);
  const projectRelated = looksProjectRelated(latestUserMessage);
  const includeSourceFiles =
    options.includeSourceFiles ??
    ((session.turn <= 1 && projectRelated) || wantsRepoStructure(latestUserMessage));
  return {
    latestUserMessage,
    includeInstructions: options.includeInstructions ?? projectRelated,
    includeSkills: options.includeSkills ?? wantsSkills(latestUserMessage),
    includeAgents: options.includeAgents ?? wantsAgents(latestUserMessage),
    includeSourceFiles,
  };
}

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
 * Returns a copy of messages with older turns compressed.
 * Keeps the last `keepFullTurns` assistant turns intact. Older tool results are
 * replaced with structured summaries, duplicate large results become reference
 * stubs, and long user/assistant text is compacted.
 */
export function trimMessagesForSending(
  messages: ModelMessage[],
  keepFullTurns = 1,
  maxTextChars = 500,
  /** Results/text shorter than this are never compacted (default: 120 chars). */
  minCharsBefore = 120,
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

  const seenToolOutputs = new Map<string, string>();

  return messages.map((msg, idx) => {
    if (idx >= cutoffIndex) return msg; // keep recent messages intact
    if (msg.role === "user" || msg.role === "assistant") {
      return compactTextMessage(msg, maxTextChars, minCharsBefore);
    }
    if (msg.role !== "tool") return msg;

    const parts = msg.content as ToolResultPart[];
    const compressedParts = parts.map((part) => {
      const toolName = typeof part.toolName === "string" ? part.toolName : "tool";
      const resultStr = stringifyToolOutput(part.output);
      if (resultStr.length < minCharsBefore) return part;

      const summary = summarizeToolResult(toolName, part.output, resultStr);
      const previousSummary = seenToolOutputs.get(resultStr);
      seenToolOutputs.set(resultStr, summary);

      return {
        ...part,
        output: {
          type: "text" as const,
          value: previousSummary
            ? `[duplicate ${toolName} result omitted; same as earlier: ${previousSummary}]`
            : summary,
        },
      };
    });
    return { ...msg, content: compressedParts };
  });
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function compactTextMessage(
  msg: Extract<ModelMessage, { role: "user" | "assistant" }>,
  maxChars: number,
  minCharsBefore: number,
): ModelMessage {
  if (typeof msg.content !== "string") return msg;
  if (msg.content.length < minCharsBefore) return msg;

  const content = stripRepeatedContext(msg.content);
  if (content.length <= maxChars) {
    return content === msg.content ? msg : { ...msg, content };
  }

  const label = msg.role === "user" ? "older user turn" : "older assistant turn";
  return {
    ...msg,
    content: `[${label} compacted]\n${compactText(content, maxChars)}`,
  };
}

function stripRepeatedContext(text: string): string {
  const withoutAttachments = text.split("\n\n--- Attachments ---")[0] ?? text;
  return withoutAttachments
    .replaceAll(/--- Project files snapshot ---[\s\S]*?--- End project files snapshot\. ---/g, "[project file snapshot omitted]")
    .replaceAll(/--- Project instructions ---[\s\S]*?(?=\n\n--- |\n\nMODE:|$)/g, "[project instructions omitted]")
    .trim();
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;

  const head = normalized.slice(0, Math.floor(maxChars * 0.75)).trim();
  const important = extractImportantFragments(normalized).join(" ");
  const suffix = important ? ` Key refs: ${important}` : "";
  return `${head}...[${normalized.length - head.length} chars omitted]${suffix}`.slice(0, maxChars + 120);
}

function extractImportantFragments(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|json|md)\b/g)) {
    refs.add(match[0]);
    if (refs.size >= 8) break;
  }
  return [...refs];
}

function summarizeToolResult(toolName: string, output: unknown, resultStr: string): string {
  const parsed = typeof output === "object" && output !== null
    ? output as Record<string, unknown>
    : parseJsonObject(resultStr);

  const error = stringValue(parsed?.error);
  if (error) return `${toolName} -> error: ${firstLine(error)}`;

  if (toolName === "view") {
    const path = stringValue(parsed?.path) ?? "unknown";
    const start = numberValue(parsed?.startLine);
    const end = numberValue(parsed?.endLine);
    const total = numberValue(parsed?.totalLines);
    const read = start != null && end != null ? Math.max(0, end - start + 1) : undefined;
    return `view(${path}${start != null ? `:${start}-${end ?? "?"}` : ""}) -> read ${read ?? "?"} lines${total != null ? ` of ${total}` : ""}`;
  }

  if (toolName === "grep") {
    const pattern = stringValue(parsed?.pattern) ?? "?";
    const count = numberValue(parsed?.count);
    const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
    const files = new Set(
      matches
        .map((match) => typeof match === "object" && match !== null
          ? stringValue((match as Record<string, unknown>).file)
          : undefined)
        .filter(Boolean),
    );
    return `grep(${JSON.stringify(pattern)}) -> ${count ?? matches.length} matches${files.size > 0 ? ` across ${files.size} files` : ""}`;
  }

  if (toolName === "bash") {
    const exitCode = numberValue(parsed?.exitCode);
    const stdoutText = stringValue(parsed?.stdout) ?? "";
    const stderrText = stringValue(parsed?.stderr) ?? "";
    const stderrSummary = stderrText.trim() ? `; stderr: ${firstLine(stderrText)}` : "";
    return `bash -> exit ${exitCode ?? "?"}; stdout ${stdoutText.length} chars; stderr ${stderrText.length} chars${stderrSummary}`;
  }

  if (toolName === "edit" || toolName === "create") {
    const path = stringValue(parsed?.path) ?? "unknown";
    const bytes = numberValue(parsed?.bytes);
    return `${toolName}(${path}) -> ok${bytes != null ? `, ${bytes} bytes` : ""}`;
  }

  if (toolName === "web_fetch") {
    const url = stringValue(parsed?.url) ?? "unknown";
    const status = numberValue(parsed?.status);
    const contentType = stringValue(parsed?.contentType);
    const body = stringValue(parsed?.body) ?? "";
    return `web_fetch(${url}) -> status ${status ?? "?"}${contentType ? `, ${contentType}` : ""}, body ${body.length} chars`;
  }

  const text = typeof output === "string" ? output : resultStr;
  const label = text.toLowerCase().includes("error") ? `error: ${firstLine(text)}` : `${text.length} chars`;
  return `${toolName} -> result summarized (${label})`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.slice(0, 180) ?? "";
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
export function buildSystemPrompt(
  session: Session,
  options: SystemPromptOptions = {},
): string {
  const promptOptions = resolvePromptOptions(session, options);
  const base =
    "You are nlpilot, a helpful AI coding assistant running in a terminal.\n" +
    "Tools available: view (read file lines), bash, edit, create, grep (also does file discovery via filenamesOnly:true), web_fetch, delegate_task (smaller read/search/bash subtask), delegate_research (read-only research subtask), plus any registered MCP tools.\n\n" +
    "Keep context small: use grep before view, prefer targeted edits, avoid broad file reads, and ask a clarifying question when it avoids unnecessary tool calls. Use delegate_task for focused subtasks that would otherwise require many search/read/bash calls in the main context, such as dependency checks, project overview, test discovery, or narrow debugging. Use delegate_research when the subtask must be strictly read-only. For broad review/check/explain/debug tasks, or whenever you expect more than 3 grep/view/bash calls, delegate first with a narrow task and relevant path hints. Parent task must do all edits. Use view only when grep context is insufficient. Do not re-read files after edits just to verify.\n\n" +
    "Be concise.";

  let modeNote = "\n\nMODE: ask. Ask the user before taking non-trivial actions.";
  if (session.mode === "plan") {
    modeNote =
      "\n\nMODE: plan. Before invoking any mutating tool, produce a short numbered plan and ask the user to confirm. Prefer read-only tools (view, grep, web_fetch) until the plan is confirmed.";
  } else if (session.mode === "autopilot") {
    modeNote =
      "\n\nMODE: autopilot. The user has authorized you to run all tools without per-call approval. Still avoid destructive operations unless clearly requested.";
  }

  const instrBlock =
    promptOptions.includeInstructions && session.instructions.files.length > 0
      ? "\n\n--- Project instructions ---\n" +
        session.instructions.files
          .map((f) => {
            const estTokens = Math.ceil(f.content.length / 4);
            const MAX_INSTRUCTION_CHARS = 6_000; // ~1.5 k tokens
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
    promptOptions.includeSkills && session.skills.length > 0
      ? "\n\n--- Available skills (invoke via /SKILL-NAME) ---\n" +
        session.skills
          .map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`)
          .join("\n")
      : "";

  const agentsBlock =
    promptOptions.includeAgents && session.agents.length > 0
      ? "\n\n--- Custom agents available ---\n" +
        session.agents
          .map((a) => `- ${a.name}${a.description ? `: ${a.description}` : ""}`)
          .join("\n")
      : "";

  const fileTreeBlock = promptOptions.includeSourceFiles
    ? "\n\n--- Project files snapshot ---\n" +
      [
        ...(session.sourceFileSummary && session.sourceFileSummary.length > 0
          ? ["Directory summary:", ...session.sourceFileSummary]
          : []),
        ...(session.sourceFiles && session.sourceFiles.length > 0
          ? [
              session.sourceFileSummary && session.sourceFileSummary.length > 0
                ? "Key files:"
                : "Files:",
              ...session.sourceFiles,
            ]
          : []),
        session.sourceFilesOmitted && session.sourceFilesOmitted > 0
          ? `[${session.sourceFilesOmitted.toLocaleString()} more files omitted; use grep filenamesOnly:true for discovery only when needed.]`
          : "",
      ].filter(Boolean).join("\n") +
      "\n--- End project files snapshot. ---"
    : "";

  return base + modeNote + instrBlock + skillsBlock + agentsBlock + fileTreeBlock;
}
