import type { LanguageModel, ModelMessage } from "ai";
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

export function buildSystemPrompt(session: Session): string {
  const base =
    "You are nlpilot, a helpful AI coding assistant running in a terminal.\n" +
    "Tools available: bash, view, edit, create, glob, grep, web_fetch, plus any registered MCP tools.\n\n" +
    "CONTEXT EFFICIENCY (important):\n" +
    "- Never read entire files unless they are clearly small. Default to `view` with `startLine`/`endLine`.\n" +
    "- Use `glob` to discover files; do NOT scan whole directories with `view`.\n" +
    "- Use `grep` first to locate symbols/strings, then `view` only the narrow line range around the hit (use `contextLines` for ~5 lines around).\n" +
    "- Prefer one targeted tool call over many wide ones; do not pre-load files ‘just in case’.\n" +
    "- Stop reading once you have enough to act.\n\n" +
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
          .map((f) => `# ${f.path}\n${f.content}`)
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

  return base + modeNote + instrBlock + skillsBlock + agentsBlock;
}
