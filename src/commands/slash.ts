import kleur from "kleur";
import { spawn } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { generateText } from "ai";
import { buildCompactTranscript } from "./compact.ts";
import pkg from "../../package.json" with { type: "json" };
import {
  buildSystemPrompt,
  loadCustomization,
  loadInstructions,
  type Mode,
  type Session,
  type Theme,
} from "../session.ts";
import { listModels, getModelContextSize } from "../models.ts";
import { PROVIDER_LABELS, getModel } from "../providers.ts";
import type { ApprovalState } from "../tools/approval.ts";
import {
  deleteSession,
  listSessions,
  renameSession,
} from "../persistence.ts";
import { initCommand } from "./init.ts";
import {
  getContextStats,
  formatContextStats,
} from "../telemetry/TokenTracker.ts";
import { startLoader, stopLoader } from "../ui/loader.ts";

export interface SlashContext {
  session: Session;
  approvals: ApprovalState;
  /** Print the help block. */
  printHelp: () => void;
  /** Request app exit (returns true to break the REPL loop). */
  setShouldExit: () => void;
  /** Disable automatic per-turn model routing after an explicit model change. */
  setModelPinned?: () => void;
  /**
   * Flat list of every registered tool description string.
   * Used by /stats to estimate tool-schema token overhead that is sent to
   * the API with every request but not reflected in message history.
   */
  toolDescriptions: string[];
}

export type SlashHandler = (
  ctx: SlashContext,
  args: string,
) => void | Promise<void>;

interface SlashSpec {
  names: string[];
  description: string;
  handler: SlashHandler;
}

const COMMANDS: SlashSpec[] = [
  {
    names: ["exit", "quit"],
    description: "Exit nlpilot",
    handler: (ctx) => {
      ctx.setShouldExit();
    },
  },
  {
    names: ["clear", "new", "reset"],
    description: "Start a new conversation (clears history)",
    handler: (ctx) => {
      ctx.session.messages = [];
      ctx.session.fileChanges = [];
      ctx.session.lastAssistantText = "";
      ctx.session.turn = 0;
      console.log(kleur.green("✓"), "Conversation reset");
    },
  },
  {
    names: ["help"],
    description: "Show this help",
    handler: (ctx) => {
      ctx.printHelp();
    },
  },
  {
    names: ["version"],
    description: "Print version",
    handler: () => {
      console.log(`nlpilot v${pkg.version}`);
    },
  },
  {
    names: ["model", "models"],
    description: "List available models, or switch with /model <id>",
    handler: ({ session, setModelPinned }, args) => {
      if (!args) {
        printAvailableModels(session);
        return;
      }
      try {
        session.languageModel = getModel(session.creds, args);
        session.modelName = args;
        setModelPinned?.();
        console.log(kleur.green("✓"), `Switched model to ${kleur.bold(args)}`);
      } catch (err) {
        console.error(kleur.red("✗"), err instanceof Error ? err.message : String(err));
      }
    },
  },
  {
    names: ["mode"],
    description: "Show or change mode: ask | plan | autopilot",
    handler: ({ session, approvals }, args) => {
      const next = args.trim() as Mode;
      if (!args) {
        console.log(`Current mode: ${kleur.bold(session.mode)}`);
        console.log(kleur.dim("Switch with /mode ask | plan | autopilot"));
        return;
      }
      if (next !== "ask" && next !== "plan" && next !== "autopilot") {
        console.log(kleur.red("✗"), `Unknown mode: ${args}`);
        return;
      }
      session.mode = next;
      approvals.autopilot = next === "autopilot";
      console.log(kleur.green("✓"), `Mode → ${kleur.bold(next)}`);
    },
  },
  {
    names: ["context"],
    description: "Show context window usage and token statistics",
    handler: ({ session }) => {
      // Extract provider from credentials
      const provider = session.creds.provider;
      const modelId = session.modelName;
      
      const stats = getContextStats(
        session.cumulativeInputTokens,
        session.cumulativeOutputTokens,
        provider,
        modelId,
        true, // isActual = true, we're using real API counts
      );
      
      console.log();
      console.log(kleur.bold("Context Window Status"));
      console.log(kleur.dim("─".repeat(40)));
      console.log(`Model: ${kleur.cyan(modelId)}`);
      console.log(`Messages: ${session.messages.length}`);
      console.log(formatContextStats(stats));
      
      if (stats.isApproachingLimit && stats.contextSize) {
        console.log();
        console.log(
          kleur.yellow("⚠ Approaching context limit!"),
        );
        console.log(
          kleur.dim(
            `Use /compact to reduce conversation size, or switch to a model with larger context window.`,
          ),
        );
      }
      console.log();
    },
  },
  {
    names: ["stats"],
    description: "Show context breakdown: system prompt, messages, cumulative API usage",
    handler: ({ session, toolDescriptions }) => {
      const provider = session.creds.provider;
      const modelId = session.modelName;
      const contextSize = getModelContextSize(provider, modelId);

      // Estimate system prompt tokens.
      const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
      const latestUserMessage =
        lastUser && typeof lastUser.content === "string" ? lastUser.content : undefined;
      const sysPrompt = buildSystemPrompt(session, { latestUserMessage });
      const sysTokens = Math.ceil(sysPrompt.length / 4);

      // Estimate messages tokens.
      let msgChars = 0;
      for (const m of session.messages) {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        msgChars += content.length;
      }
      const msgTokens = Math.ceil(msgChars / 4);

      // Estimate tool schema tokens: description text + ~150-token JSON schema overhead per tool.
      // Tool definitions are serialised and sent with EVERY API call, but are
      // not part of message history, so the message estimate always under-counts.
      const toolCount = toolDescriptions.length;
      const toolDescChars = toolDescriptions.reduce((sum, d) => sum + d.length, 0);
      const toolTokens = Math.ceil(toolDescChars / 4) + toolCount * 150;

      const totalEstimated = sysTokens + msgTokens + toolTokens;
      const estimatedPct = ((totalEstimated / contextSize) * 100).toFixed(1);

      const cumulativeTotal = session.cumulativeInputTokens + session.cumulativeOutputTokens;
      const cumulativePct = ((cumulativeTotal / contextSize) * 100).toFixed(1);

      console.log();
      console.log(kleur.bold("Context Breakdown (estimated)"));
      console.log(kleur.dim("-".repeat(48)));
      console.log(`  System prompt   ${sysTokens.toLocaleString().padStart(10)} tokens`);
      console.log(`  Messages        ${msgTokens.toLocaleString().padStart(10)} tokens  (${session.messages.length} msgs)`);
      console.log(`  Tool schemas    ${toolTokens.toLocaleString().padStart(10)} tokens  (${toolCount} tools, sent every turn)`);
      console.log(`  Estimated total ${totalEstimated.toLocaleString().padStart(10)} / ${Math.round(contextSize / 1_000)}k  (${estimatedPct}%)`);
      console.log();
      console.log(kleur.bold("Cumulative API Usage (actual)"));
      console.log(kleur.dim("-".repeat(48)));
      console.log(`  Input           ${session.cumulativeInputTokens.toLocaleString().padStart(10)} tokens`);
      console.log(`  Output          ${session.cumulativeOutputTokens.toLocaleString().padStart(10)} tokens`);
      console.log(`  Total           ${cumulativeTotal.toLocaleString().padStart(10)} / ${Math.round(contextSize / 1_000)}k  (${cumulativePct}%)`);
      console.log();
    },
  },
  {
    names: ["copy"],
    description: "Copy last assistant response to clipboard",
    handler: async ({ session }) => {
      if (!session.lastAssistantText) {
        console.log(kleur.yellow("Nothing to copy yet."));
        return;
      }
      const ok = await copyToClipboard(session.lastAssistantText);
      console.log(
        ok ? kleur.green("✓ Copied to clipboard") : kleur.red("✗ Clipboard not available"),
      );
    },
  },
  {
    names: ["diff"],
    description: "Show file changes made this session",
    handler: ({ session }) => {
      if (session.fileChanges.length === 0) {
        console.log(kleur.dim("No file changes recorded."));
        return;
      }
      for (const change of session.fileChanges) {
        const action = change.before === null ? "create" : "edit";
        const turnLabel = kleur.dim(`(turn ${change.turn})`);
        console.log(`${kleur.bold(action)} ${change.path} ${turnLabel}`);
      }
    },
  },
  {
    names: ["undo", "rewind"],
    description: "Revert the last turn's file changes",
    handler: async ({ session }) => {
      if (session.fileChanges.length === 0) {
        console.log(kleur.dim("No file changes to undo."));
        return;
      }
      const last = session.fileChanges.at(-1);
      if (!last) {
        console.log(kleur.dim("No file changes to undo."));
        return;
      }
      const lastTurn = last.turn;
      const toRevert = session.fileChanges.filter((c) => c.turn === lastTurn);
      session.fileChanges = session.fileChanges.filter((c) => c.turn !== lastTurn);
      for (const change of toRevert.toReversed()) {
        try {
          if (change.before === null) {
            await unlink(change.path);
            console.log(kleur.green("✓"), `removed ${change.path}`);
          } else {
            await writeFile(change.path, change.before, "utf8");
            console.log(kleur.green("✓"), `restored ${change.path}`);
          }
        } catch (err) {
          console.error(
            kleur.red("✗"),
            `failed to revert ${change.path}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    },
  },
  {
    names: ["instructions"],
    description: "Show loaded custom instruction files",
    handler: async ({ session }) => {
      session.instructions = await loadInstructions();
      if (session.instructions.files.length === 0) {
        console.log(kleur.dim("No instruction files found."));
        console.log(
          kleur.dim("Looked for: .nlpilot/instructions.md, AGENTS.md"),
        );
        return;
      }
      for (const f of session.instructions.files) {
        console.log(kleur.bold().cyan(f.path));
        console.log(f.content);
        console.log();
      }
    },
  },
  {
    names: ["theme"],
    description: "Switch theme: default | dim | high-contrast",
    handler: ({ session }, args) => {
      const next = args.trim() as Theme;
      if (!args) {
        console.log(`Current theme: ${kleur.bold(session.theme)}`);
        console.log(kleur.dim("Switch with /theme default | dim | high-contrast"));
        return;
      }
      if (next !== "default" && next !== "dim" && next !== "high-contrast") {
        console.log(kleur.red("✗"), `Unknown theme: ${args}`);
        return;
      }
      session.theme = next;
      kleur.enabled = next !== "dim";
      console.log(kleur.green("✓"), `Theme → ${kleur.bold(next)}`);
    },
  },
  {
    names: ["compact"],
    description: "Summarize conversation to reduce context",
    handler: async ({ session }) => {
      if (session.messages.length === 0) {
        console.log(kleur.dim("Nothing to compact."));
        return;
      }
      console.log(kleur.dim("Compacting conversation…"));
      try {
        const transcript = buildCompactTranscript(session.messages);
        startLoader("Summarizing...");
        const result = await generateText({
          model: session.languageModel,
          system:
            "You are a conversation summarizer. Produce a concise but information-dense summary of the prior assistant/user turns. Preserve decisions, code paths touched, and open TODOs. Do not invent details.",
          prompt: `Summarize the following conversation:\n\n${transcript}`,
        });
        stopLoader();
        const summary = result.text.trim();
        session.messages = [
          {
            role: "user",
            content: `Summary of prior conversation:\n${summary}`,
          },
          {
            role: "assistant",
            content: "Acknowledged. Continuing from this summary.",
          },
        ];
        // Reset cumulative token counts to reflect the compacted state.
        session.cumulativeInputTokens = result.usage.inputTokens ?? 0;
        session.cumulativeOutputTokens = result.usage.outputTokens ?? 0;
        console.log(kleur.green("✓"), "Conversation compacted");
      } catch (err) {
        console.error(
          kleur.red("✗"),
          "Compact failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  },
  {
    names: ["init"],
    description: "Analyze repo and write .nlpilot/instructions.md",
    handler: async ({ session }) => {
      await initCommand();
      const next = await loadCustomization();
      session.instructions = next.instructions;
      session.agents = next.agents;
      session.skills = next.skills;
      session.hooks = next.hooks;
    },
  },
  {
    names: ["session"],
    description: "Manage saved sessions: info | list | rename <name> | delete <id>",
    handler: async ({ session }, args) => {
      const [action, ...rest] = args.split(/\s+/).filter(Boolean);
      const sub = action ?? "info";
      if (sub === "info") {
        console.log(kleur.bold("Session"));
        console.log(`  id:        ${session.id}`);
        console.log(`  name:      ${session.name ?? kleur.dim("(unnamed)")}`);
        console.log(`  messages:  ${session.messages.length}`);
        console.log(`  createdAt: ${new Date(session.createdAt).toISOString()}`);
        return;
      }
      if (sub === "list") {
        const sessions = await listSessions(process.cwd());
        if (sessions.length === 0) {
          console.log(kleur.dim("No sessions in this cwd."));
          return;
        }
        for (const s of sessions) {
          const marker = s.id === session.id ? kleur.green("●") : " ";
          const label = s.name ?? kleur.dim("(unnamed)");
          console.log(
            `  ${marker} ${kleur.bold(s.id)}  ${label}  ${kleur.dim(`${s.messages.length} msgs`)}  ${kleur.dim(new Date(s.updatedAt).toISOString())}`,
          );
        }
        return;
      }
      if (sub === "rename") {
        const newName = rest.join(" ").trim();
        if (!newName) {
          console.log(kleur.yellow("Usage: /session rename <name>"));
          return;
        }
        await renameSession(session.id, newName, process.cwd());
        session.name = newName;
        console.log(kleur.green("✓"), `Renamed session to ${kleur.bold(newName)}`);
        return;
      }
      if (sub === "delete") {
        const targetId = rest[0];
        if (!targetId) {
          console.log(kleur.yellow("Usage: /session delete <id>"));
          return;
        }
        if (targetId === session.id) {
          console.log(kleur.red("✗"), "Cannot delete the active session");
          return;
        }
        await deleteSession(targetId, process.cwd());
        console.log(kleur.green("✓"), `Deleted session ${targetId}`);
        return;
      }
      console.log(kleur.red("✗"), `Unknown /session action: ${sub}`);
    },
  },
  {
    names: ["agent", "agents"],
    description: "List custom agents (or activate one with /agent <name>)",
    handler: async ({ session, setModelPinned }, args) => {
      if (!args) {
        if (session.agents.length === 0) {
          console.log(kleur.dim("No custom agents in .nlpilot/agents/"));
          return;
        }
        for (const a of session.agents) {
          console.log(`  ${kleur.bold(a.name)}${a.description ? kleur.dim(` — ${a.description}`) : ""}`);
        }
        return;
      }
      const target = session.agents.find((a) => a.name === args.trim());
      if (!target) {
        console.log(kleur.red("✗"), `No agent named ${args.trim()}`);
        return;
      }
      session.messages.push({
        role: "user",
        content: `Switching to custom agent "${target.name}". Operate according to:\n\n${target.body}`,
      });
      if (target.model) {
        try {
          session.languageModel = getModel(session.creds, target.model);
          session.modelName = target.model;
          setModelPinned?.();
        } catch {
          /* ignore */
        }
      }
      console.log(kleur.green("✓"), `Activated agent ${kleur.bold(target.name)}`);
    },
  },
  {
    names: ["skill", "skills"],
    description: "List skills (or invoke one with /skill <name>)",
    handler: async ({ session }, args) => {
      if (!args) {
        if (session.skills.length === 0) {
          console.log(kleur.dim("No skills in .nlpilot/skills/"));
          return;
        }
        for (const s of session.skills) {
          console.log(`  ${kleur.bold(s.name)}${s.description ? kleur.dim(` — ${s.description}`) : ""}`);
        }
        return;
      }
      const target = session.skills.find((s) => s.name === args.trim());
      if (!target) {
        console.log(kleur.red("✗"), `No skill named ${args.trim()}`);
        return;
      }
      session.messages.push({
        role: "user",
        content: `Apply the following skill instructions:\n\n${target.body}`,
      });
      console.log(kleur.green("✓"), `Loaded skill ${kleur.bold(target.name)}`);
    },
  },
  {
    names: ["hooks"],
    description: "Show configured lifecycle hooks",
    handler: ({ session }) => {
      if (session.hooks.hooks.length === 0) {
        console.log(kleur.dim("No hooks configured (.nlpilot/hooks/hooks.json)"));
        return;
      }
      for (const h of session.hooks.hooks) {
        const target = h.type === "command" ? h.command : h.url;
        const matchPart = h.match ? kleur.dim(` match=${h.match}`) : "";
        console.log(`  ${kleur.cyan(h.event.padEnd(14))} ${kleur.dim(h.type.padEnd(8))} ${target ?? ""}${matchPart}`);
      }
    },
  },
  {
    names: ["plan"],
    description: "Generate a step-by-step plan from your last input or args",
    handler: async ({ session }, args) => {
      const lastUser = [...session.messages].reverse().find((m) => m.role === "user");
      const seed = args.trim() || (lastUser && typeof lastUser.content === "string" ? lastUser.content : "");
      if (!seed) {
        console.log(kleur.yellow("Usage: /plan <goal>"));
        return;
      }
      console.log(kleur.dim("Drafting plan…"));
      try {
        startLoader("Planning...");
        const result = await generateText({
          model: session.languageModel,
          system:
            "You are a software planning assistant. Produce a numbered, concrete step-by-step plan for the goal. Each step must be actionable and reference real files when relevant. End with a 'Risks' section.",
          prompt: seed,
        });
        stopLoader();
        console.log();
        console.log(result.text.trim());
        console.log();
        session.mode = "plan";
        console.log(kleur.green("✓"), "Plan ready — mode set to plan. Switch to /mode autopilot or /mode ask to execute.");
      } catch (err) {
        stopLoader();
        console.error(kleur.red("✗"), "Plan failed:", err instanceof Error ? err.message : String(err));
      }
    },
  },
];

function printAvailableModels(session: Session): void {
  console.log(kleur.bold().magenta(PROVIDER_LABELS[session.creds.provider]));
  for (const m of listModels(session.creds.provider)) {
    const isActive = m.id === session.modelName;
    const marker = isActive ? kleur.green("●") : " ";
    const label = isActive ? kleur.bold(m.label) : m.label;
    const description = m.description ? kleur.dim(` — ${m.description}`) : "";
    console.log(`  ${marker} ${label}${description}`);
  }
  console.log(kleur.dim("Switch with: /model <id>"));
}

export function buildHelpPrinter(): () => void {
  return () => {
    console.log(kleur.bold("Slash commands"));
    for (const cmd of COMMANDS) {
      const names = cmd.names.map((n) => `/${n}`).join(", ");
      console.log(`  ${kleur.cyan(names.padEnd(28))} ${cmd.description}`);
    }
    console.log();
    console.log(kleur.bold("Prefixes"));
    console.log(
      `  ${kleur.cyan("@FILE".padEnd(28))} attach file contents inline`,
    );
    console.log(
      `  ${kleur.cyan("!CMD".padEnd(28))} run a shell command (bypasses AI)`,
    );
    console.log(`  ${kleur.cyan("?".padEnd(28))} show this help`);
  };
}

export async function runSlashCommand(
  ctx: SlashContext,
  raw: string,
): Promise<void> {
  const trimmed = raw.replace(/^\//, "");
  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  for (const cmd of COMMANDS) {
    if (cmd.names.includes(name)) {
      await cmd.handler(ctx, args);
      return;
    }
  }
  console.log(kleur.red("✗"), `Unknown command: /${name}`);
  console.log(kleur.dim("Type /help to see available commands."));
}

async function copyToClipboard(text: string): Promise<boolean> {
  let cmd = "xclip";
  if (process.platform === "darwin") cmd = "pbcopy";
  else if (process.platform === "win32") cmd = "clip";
  return await new Promise<boolean>((resolve) => {
    const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}
