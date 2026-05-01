import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { Glob } from "bun";
import { streamText, stepCountIs } from "ai";
import kleur from "kleur";
import { resolveCredentials, DEFAULT_MODELS } from "../config.ts";
import { getModel, PROVIDER_LABELS } from "../providers.ts";
import { getModelContextSize } from "../models.ts";
import { buildTools } from "../tools/index.ts";
import { createApprovalState } from "../tools/approval.ts";
import {
  buildSystemPrompt,
  trimMessagesForSending,
  loadCustomization,
  type Session,
} from "../session.ts";
import { buildHelpPrinter, runSlashCommand } from "./slash.ts";
import {
  loadMostRecentSession,
  newSessionId,
  saveSession,
} from "../persistence.ts";
import { runHooks } from "../hooks.ts";
import { runAutoCompact, estimateTokens } from "./compact.ts";
import { loadEffectiveMcpConfig, loadProjectMcpConfig, getProjectMcpConfigPath } from "../mcp.ts";
import { startMcpRuntime } from "../tools/mcp.ts";
import { startLoader, stopLoader, stopLoaderWithMessage } from "../ui/loader.ts";

interface ReplOptions {
  model?: string;
  continueSession?: boolean;
  allowAll?: boolean;
  allow?: string[];
  deny?: string[];
}

/** Returns a short human-readable summary of tool inputs for display. */
function toolInputSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "bash":
      return typeof input.command === "string" ? input.command : "";
    case "view":
    case "edit":
    case "create": {
      const p = typeof input.path === "string" ? input.path : "";
      const range =
        input.startLine != null
          ? ` (lines ${input.startLine}–${input.endLine ?? "…"})`
          : "";
      return p + range;
    }
    case "grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const glob = typeof input.glob === "string" ? ` in ${input.glob}` : "";
      return `"${pattern}"${glob}`;
    }
    case "glob":
      return typeof input.pattern === "string" ? input.pattern : "";
    default:
      return "";
  }
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const creds = await resolveCredentials();
  if (!creds) {
    console.log(
      kleur.red("✗"),
      "No credentials found. Run",
      kleur.bold("nlpilot login"),
      "first.",
    );
    process.exitCode = 1;
    return;
  }

  const modelName = options.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];

  let priorMessages: Session["messages"] = [];
  let priorId: string | undefined;
  let priorName: string | undefined;
  let priorCreatedAt: number | undefined;
  let priorInputTokens = 0;
  let priorOutputTokens = 0;
  if (options.continueSession) {
    const prior = await loadMostRecentSession();
    if (prior) {
      priorMessages = prior.messages;
      priorId = prior.id;
      priorName = prior.name;
      priorCreatedAt = prior.createdAt;
      priorInputTokens = prior.cumulativeInputTokens ?? 0;
      priorOutputTokens = prior.cumulativeOutputTokens ?? 0;
      console.log(
        kleur.dim(`Restored ${prior.messages.length} messages from session ${prior.name ?? prior.id}.`),
      );
    }
  }

  const customization = await loadCustomization();
  const session: Session = {
    id: priorId ?? newSessionId(),
    name: priorName,
    createdAt: priorCreatedAt ?? Date.now(),
    creds,
    modelName,
    languageModel: getModel(creds, modelName),
    messages: priorMessages,
    mode: options.allowAll ? "autopilot" : "ask",
    theme: "default",
    turn: 0,
    fileChanges: [],
    lastAssistantText: "",
    instructions: customization.instructions,
    agents: customization.agents,
    skills: customization.skills,
    hooks: customization.hooks,
    cumulativeInputTokens: priorInputTokens,
    cumulativeOutputTokens: priorOutputTokens,
  };

  // Pre-scan source files and inject into system prompt so the model never
  // needs discovery tool calls (find/ls/glob) to know what files exist.
  try {
    const g = new Glob("**/*.{ts,tsx,js,jsx,mjs,mts,json,md}");
    const files: string[] = [];
    for await (const f of g.scan({ cwd: process.cwd(), onlyFiles: true })) {
      if (!f.includes("node_modules") && !f.includes(".git") && !f.startsWith("dist/")) {
        files.push(f);
        if (files.length >= 300) break;
      }
    }
    files.sort();
    session.sourceFiles = files;
  } catch {
    // non-fatal — model can still use grep filenamesOnly
  }

  await runHooks(session.hooks, "sessionStart", { sessionId: session.id, cwd: process.cwd() });

  printLogo();
  printBanner(session);
  await announceProjectMcp();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const approvals = createApprovalState({
    autopilot: options.allowAll,
    allow: options.allow,
    deny: options.deny,
  });
  // Approval prompts must NOT share the REPL's readline instance — tool execute
  // functions run DURING stream iteration and sharing rl would deadlock Bun's
  // readline. Use a separate interface that closes immediately after each prompt.
  // After closing, stdin.resume() is required because readline.close() pauses stdin,
  // which would leave the main rl unable to receive further input.
  const promptFn = (q: string): Promise<string> =>
    new Promise((resolve) => {
      const approvalRl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
      stdout.write(q);
      approvalRl.once("line", (answer) => {
        approvalRl.close();
        stdin.resume();
        resolve(answer);
      });
    });
  const viewedFiles = new Set<string>();
  const editedFiles = new Set<string>();
  const tools = buildTools({
    approvals,
    prompt: promptFn,
    viewedFiles,
    editedFiles,
    recorder: {
      record: (change) => {
        session.fileChanges.push({
          ...change,
          turn: session.turn,
          timestamp: Date.now(),
        });
      },
    },
  });

  // Bring up MCP runtime (global + project .mcp.json) and merge its tools.
  const mcpConfig = await loadEffectiveMcpConfig();
  const mcp = await startMcpRuntime(mcpConfig.servers);
  Object.assign(tools, mcp.tools);
  const mcpToolNames = Object.keys(mcp.tools);
  if (mcpToolNames.length > 0) {
    console.log(
      kleur.dim(
        `MCP tools available: ${mcpToolNames.join(", ")}`,
      ),
    );
  }

  const printHelp = buildHelpPrinter();

  let shouldExit = false;
  // Collect tool descriptions for /stats token estimation.
  const toolDescriptions = Object.values(tools)
    .map((t) => (t as { description?: string }).description ?? "")
    .filter(Boolean);

  const slashCtx = {
    session,
    approvals,
    printHelp,
    toolDescriptions,
    setShouldExit: () => {
      shouldExit = true;
    },
  };

  const cleanup = (): void => {
    rl.close();
    console.log();
    console.log(kleur.dim("bye 👋"));
  };

  rl.on("SIGINT", () => {
    void mcp.shutdown().finally(() => {
      cleanup();
      process.exit(0);
    });
  });

  // Ctrl+L → clear screen
  if (stdin.isTTY) {
    stdin.on("keypress", (_str, key) => {
      if (key?.ctrl && key.name === "l") {
        stdout.write("\x1Bc");
      }
    });
  }

  while (!shouldExit) {
    let userInput: string;
    try {
      userInput = await rl.question(promptString(session));
    } catch {
      cleanup();
      return;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    // ? → quick help
    if (trimmed === "?") {
      printHelp();
      continue;
    }

    // /command
    if (trimmed.startsWith("/")) {
      await runSlashCommand(slashCtx, trimmed);
      continue;
    }

    // !command → shell passthrough
    if (trimmed.startsWith("!")) {
      await runShellPassthrough(trimmed.slice(1).trim());
      continue;
    }

    // @file expansion (any token starting with @)
    const expanded = await expandAttachments(trimmed);

    session.turn += 1;
    session.messages.push({ role: "user", content: expanded });
    // Reset per-turn file tracking.
    viewedFiles.clear();
    editedFiles.clear();

    try {
      startLoader("Thinking...");
      const result = streamText({
        model: session.languageModel,
        system: buildSystemPrompt(session),
        messages: trimMessagesForSending(session.messages),
        tools,
        // Cap steps per mode: autopilot gets more room, ask/plan are tighter
        // to prevent runaway exploration on vague questions.
        stopWhen: stepCountIs(2000),
      });

      stopLoader();
      stdout.write(kleur.green("● "));
      let assistantText = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          assistantText += part.text;
          stdout.write(part.text);
        } else if (part.type === "tool-call") {
          const inputSummary = toolInputSummary(part.toolName, part.input);
          stdout.write("\n" + kleur.dim(`  → ${part.toolName}${inputSummary ? ": " + inputSummary : ""}`) + "\n");
          startLoader(`Running ${part.toolName}...`);
          await runHooks(session.hooks, "preToolUse", {
            toolName: part.toolName,
            input: part.input,
            sessionId: session.id,
            cwd: process.cwd(),
          });
        } else if (part.type === "tool-result") {
          stopLoader();
          await runHooks(session.hooks, "postToolUse", {
            toolName: part.toolName,
            output: part.output,
            sessionId: session.id,
            cwd: process.cwd(),
          });
        } else if (part.type === "error") {
          stopLoader();
          const message =
            part.error instanceof Error ? part.error.message : String(part.error);
          console.error("\n" + kleur.red("✗ Stream error:"), message);
        }
      }
      stdout.write("\n\n");

      session.lastAssistantText = assistantText;
      const [response, usage] = await Promise.all([result.response, result.totalUsage]);
      const responseMessages = response.messages;
      session.messages.push(...responseMessages);

      // Capture actual token usage from Vercel AI SDK
      session.cumulativeInputTokens += usage.inputTokens ?? 0;
      session.cumulativeOutputTokens += usage.outputTokens ?? 0;

      // Per-turn token budget warning (>25k suggests context is being saturated quickly).
      const WARN_TOKENS_PER_TURN = 25_000;
      const turnTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (turnTokens > WARN_TOKENS_PER_TURN) {
        console.log(
          kleur.yellow(`⚠ This turn used ${turnTokens.toLocaleString()} tokens (>${WARN_TOKENS_PER_TURN.toLocaleString()} per-turn suggestion)`),
        );
        console.log(kleur.dim("  Consider being more specific, or run /compact to reduce context."));
      }

      // Show per-turn usage summary.
      const contextSize = getModelContextSize(session.creds.provider, session.modelName);
      const totalTokensUsed = session.cumulativeInputTokens + session.cumulativeOutputTokens;
      const usagePct = ((totalTokensUsed / contextSize) * 100).toFixed(1);
      stdout.write(
        kleur.dim(
          `[turn: ${(usage.inputTokens ?? 0).toLocaleString()} in / ${(usage.outputTokens ?? 0).toLocaleString()} out · cumulative: ${totalTokensUsed.toLocaleString()}/${Math.round(contextSize / 1_000)}k (${usagePct}%)]\n`,
        ),
      );
      stdout.write("\n");

      await saveSession({
        id: session.id,
        name: session.name,
        cwd: process.cwd(),
        modelName: session.modelName,
        provider: session.creds.provider,
        createdAt: session.createdAt,
        updatedAt: Date.now(),
        messages: session.messages,
        cumulativeInputTokens: session.cumulativeInputTokens,
        cumulativeOutputTokens: session.cumulativeOutputTokens,
      });

      // Auto-compact when approaching 85% of the model's actual context window.
      const autoCompactThreshold = Math.floor(contextSize * 0.85);
      if (totalTokensUsed > autoCompactThreshold) {
        console.log(kleur.dim(`Context at ${usagePct}% — auto-compacting…`));
        await runAutoCompact(session);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(kleur.red("✗ Error:"), message);
      session.messages.pop();
    }
  }

  await runHooks(session.hooks, "agentStop", { sessionId: session.id, cwd: process.cwd() });
  await mcp.shutdown();
  cleanup();
}

function promptString(session: Session): string {
  let modeTag = "";
  if (session.mode === "autopilot") modeTag = kleur.red("[auto] ");
  else if (session.mode === "plan") modeTag = kleur.yellow("[plan] ");
  return modeTag + kleur.cyan("› ");
}

function printLogo(): void {
  const logo = `
  ███╗   ██╗██╗      ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗
  ████╗  ██║██║     ██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝
  ██╔██╗ ██║██║     ██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║
  ██║╚██╗██║██║     ██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║
  ██║ ╚████║███████╗╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║
  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝
  `;
  console.log(kleur.cyan(logo));
}

function printBanner(session: Session): void {
  console.log(
    kleur.bold().magenta("nlpilot"),
    kleur.dim("·"),
    `${PROVIDER_LABELS[session.creds.provider] ?? session.creds.provider}`,
    kleur.dim("·"),
    kleur.bold(session.modelName),
    kleur.dim("·"),
    `mode: ${session.mode}`,
  );
  console.log(
    kleur.dim(
      "Type /help for commands, ? for quick help, /exit to quit.",
    ),
  );
  if (session.instructions.files.length > 0) {
    console.log(
      kleur.dim(
        `Loaded instructions: ${session.instructions.files.map((f) => f.path).join(", ")}`,
      ),
    );
  }
  console.log();
}

async function announceProjectMcp(): Promise<void> {
  const cfg = await loadProjectMcpConfig();
  if (cfg.servers.length === 0) return;
  const names = cfg.servers.map((s) => s.name).join(", ");
  console.log(
    kleur.dim(
      `MCP project config: ${getProjectMcpConfigPath()} → ${names}`,
    ),
  );
  console.log();
}

async function runShellPassthrough(command: string): Promise<void> {
  if (!command) {
    console.log(kleur.yellow("Usage: !<shell command>"));
    return;
  }
  await new Promise<void>((resolveDone) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit" });
    child.on("close", () => resolveDone());
    child.on("error", (err) => {
      console.error(kleur.red("✗"), err.message);
      resolveDone();
    });
  });
}

const ATTACHMENT_INLINE_BYTES = 8_000;

async function expandAttachments(input: string): Promise<string> {
  const tokens = input.match(/@\S+/g);
  if (!tokens) return input;

  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const tok of tokens) {
    const rel = tok.slice(1);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = pathResolve(process.cwd(), rel);
    try {
      const content = await readFile(abs, "utf8");
      if (content.length <= ATTACHMENT_INLINE_BYTES) {
        blocks.push(`# ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
        console.log(kleur.dim(`  ✎ attached ${rel} (${content.length} bytes)`));
      } else {
        const head = content.slice(0, ATTACHMENT_INLINE_BYTES);
        blocks.push(
          `# ${rel} (preview: first ${ATTACHMENT_INLINE_BYTES} of ${content.length} bytes — use the \`view\` tool on ${rel} for line ranges)\n\n\`\`\`\n${head}\n\`\`\``,
        );
        console.log(
          kleur.dim(
            `  ✎ attached ${rel} (preview ${ATTACHMENT_INLINE_BYTES}/${content.length} bytes)`,
          ),
        );
      }
    } catch (err) {
      console.log(
        kleur.yellow("  ⚠"),
        `couldn't read ${rel}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (blocks.length === 0) return input;
  return `${input}\n\n--- Attachments ---\n\n${blocks.join("\n\n")}`;
}
