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
import { resolveRoutedModel } from "../model-router.ts";
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
import { runAutoCompact, runRollingCompact } from "./compact.ts";
import {
  loadEffectiveMcpConfig,
  loadProjectMcpConfig,
  getProjectMcpConfigPath,
  type MCPConfig,
  type MCPServer,
} from "../mcp.ts";
import { startMcpRuntime } from "../tools/mcp.ts";
import { startLoader, stopLoader, stopLoaderWithMessage } from "../ui/loader.ts";

interface ReplOptions {
  model?: string;
  continueSession?: boolean;
  allowAll?: boolean;
  allow?: string[];
  deny?: string[];
  maxSteps?: number;
  maxOutputTokens?: number;
  mcp?: boolean;
  compactThreshold?: number;
  modelRouting?: boolean;
  autoCompact?: boolean;
}

const PROMPT_SOURCE_FILE_LIMIT = 60;
const SOURCE_SCAN_LIMIT = 800;
const DIRECTORY_SUMMARY_LIMIT = 40;

function stepLimitForMode(mode: Session["mode"], override?: number): number {
  if (override != null) return override;
  return mode === "autopilot" ? 100 : 50;
}

function promptFilePriority(file: string): number {
  if (
    file === "package.json" ||
    file === "tsconfig.json" ||
    file === "README.md" ||
    file === "AGENTS.md" ||
    file === "INSTRUCTIONS.md" ||
    file.startsWith(".nlpilot/")
  ) {
    return 0;
  }
  if (file.startsWith("src/")) return 10;
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return 20;
  if (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs")) return 30;
  if (file.startsWith("docs/")) return 40;
  if (file.endsWith(".md")) return 50;
  if (file.endsWith(".json")) return 60;
  return 100;
}

function selectPromptSourceFiles(files: string[]): {
  files: string[];
  summary: string[];
  omitted: number;
} {
  const summary = summarizeSourceDirectories(files);
  const selected = [...files]
    .sort((a, b) => {
      const score = promptFilePriority(a) - promptFilePriority(b);
      if (score !== 0) return score;
      return a.localeCompare(b);
    })
    .slice(0, PROMPT_SOURCE_FILE_LIMIT)
    .sort();
  return {
    files: selected,
    summary,
    omitted: Math.max(0, files.length - selected.length),
  };
}

function summarizeSourceDirectories(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.split("/");
    const dir =
      parts.length === 1
        ? "."
        : parts.length === 2
          ? parts[0] ?? "."
          : `${parts[0]}/${parts[1]}`;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      const score = promptFilePriority(`${a[0]}/index.ts`) - promptFilePriority(`${b[0]}/index.ts`);
      if (score !== 0) return score;
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, DIRECTORY_SUMMARY_LIMIT)
    .map(([dir, count]) => `${dir}/ (${count})`);
}

interface ContextEstimate {
  systemTokens: number;
  messageTokens: number;
  toolTokens: number;
  totalTokens: number;
}

function estimateTextTokens(text: string): number {
  return estimateCharTokens(text.length);
}

function estimateCharTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function estimateMessageTokens(messages: Session["messages"]): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === "string"
      ? message.content.length
      : JSON.stringify(message.content).length;
  }
  return estimateCharTokens(chars);
}

function estimateToolSchemaTokens(toolDescriptions: string[]): number {
  const toolDescChars = toolDescriptions.reduce((sum, description) => {
    return sum + description.length;
  }, 0);
  return estimateCharTokens(toolDescChars) + toolDescriptions.length * 150;
}

function estimateCurrentContext(
  session: Session,
  toolDescriptions: string[],
  latestUserMessage?: string,
): ContextEstimate {
  const systemTokens = estimateTextTokens(buildSystemPrompt(session, { latestUserMessage }));
  const messageTokens = estimateMessageTokens(trimMessagesForSending(session.messages));
  const toolTokens = estimateToolSchemaTokens(toolDescriptions);
  return {
    systemTokens,
    messageTokens,
    toolTokens,
    totalTokens: systemTokens + messageTokens + toolTokens,
  };
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
  const modelPinnedByRun = Boolean(options.model || process.env.NLPILOT_MODEL);
  const autoModelRouting = options.modelRouting !== false && !modelPinnedByRun && !creds.baseUrl;

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

  // Pre-scan a compact source-file snapshot. Keep it intentionally small:
  // this text is sent on every REPL turn, so a complete tree becomes a token tax.
  try {
    const g = new Glob("**/*.{ts,tsx,js,jsx,mjs,mts,json,md}");
    const files: string[] = [];
    for await (const f of g.scan({ cwd: process.cwd(), onlyFiles: true })) {
      if (!f.includes("node_modules") && !f.includes(".git") && !f.startsWith("dist/")) {
        files.push(f);
        if (files.length >= SOURCE_SCAN_LIMIT) break;
      }
    }
    const selected = selectPromptSourceFiles(files);
    session.sourceFiles = selected.files;
    session.sourceFileSummary = selected.summary;
    session.sourceFilesOmitted = selected.omitted;
  } catch {
    // non-fatal — model can still use grep filenamesOnly
  }

  await runHooks(session.hooks, "sessionStart", { sessionId: session.id, cwd: process.cwd() });

  printLogo();
  printBanner(session);
  if (options.mcp !== false) {
    await announceProjectMcp();
  }

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

  let shutdownMcp = async (): Promise<void> => undefined;
  if (options.mcp !== false) {
    // Bring up MCP runtime. Project `.mcp.json` is repo-controlled, so it must
    // be trusted before any server command is spawned.
    const projectMcpConfig = await loadProjectMcpConfig();
    const includeProjectMcp = await confirmProjectMcp(projectMcpConfig, promptFn);
    const mcpConfig = await loadEffectiveMcpConfig(process.cwd(), {
      includeProject: includeProjectMcp,
    });
    const mcp = await startMcpRuntime(mcpConfig.servers, {
      approvals,
      prompt: promptFn,
    });
    Object.assign(tools, mcp.tools);
    shutdownMcp = mcp.shutdown;

    const mcpToolNames = Object.keys(mcp.tools);
    if (mcpToolNames.length > 0) {
      console.log(
        kleur.dim(
          `MCP tools available: ${mcpToolNames.join(", ")}`,
        ),
      );
    }
  }

  const printHelp = buildHelpPrinter();

  let shouldExit = false;
  let modelPinned = false;
  // Collect tool descriptions for /stats token estimation.
  const toolDescriptions = Object.values(tools)
    .map((t) => (t as { description?: string }).description ?? "")
    .filter(Boolean);

  const slashCtx = {
    session,
    approvals,
    printHelp,
    toolDescriptions,
    setModelPinned: () => {
      modelPinned = true;
    },
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
    void shutdownMcp().finally(() => {
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
    if (autoModelRouting && !modelPinned) {
      applyModelRoute(session, expanded);
    }

    try {
      startLoader("Thinking...");
      const systemPrompt = buildSystemPrompt(session, { latestUserMessage: expanded });
      const result = streamText({
        model: session.languageModel,
        system: systemPrompt,
        messages: trimMessagesForSending(session.messages),
        tools,
        // Cap steps per mode to prevent runaway tool loops and cost surprises.
        stopWhen: stepCountIs(stepLimitForMode(session.mode, options.maxSteps)),
        maxOutputTokens: options.maxOutputTokens,
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
      const cumulativeTokensUsed = session.cumulativeInputTokens + session.cumulativeOutputTokens;
      const contextEstimate = estimateCurrentContext(session, toolDescriptions, expanded);
      const contextPct = ((contextEstimate.totalTokens / contextSize) * 100).toFixed(1);
      stdout.write(
        kleur.dim(
          `[turn: ${(usage.inputTokens ?? 0).toLocaleString()} in / ${(usage.outputTokens ?? 0).toLocaleString()} out · context est: ${contextEstimate.totalTokens.toLocaleString()}/${Math.round(contextSize / 1_000)}k (${contextPct}%) · cumulative API: ${cumulativeTokensUsed.toLocaleString()}]\n`,
        ),
      );
      stdout.write("\n");

      let compacted = false;
      if (options.autoCompact !== false) {
        compacted = await runRollingCompact(session, 1);
      }

      // Rolling compaction runs after each turn. The threshold guard remains
      // as a backstop for unusually large single turns or disabled rolling
      // compaction.
      const compactThresholdPct = options.compactThreshold ?? 85;
      const autoCompactThreshold = Math.floor(contextSize * (compactThresholdPct / 100));
      const postRollingEstimate = compacted
        ? estimateCurrentContext(session, toolDescriptions, expanded)
        : contextEstimate;
      const postRollingPct = ((postRollingEstimate.totalTokens / contextSize) * 100).toFixed(1);
      if (postRollingEstimate.totalTokens > autoCompactThreshold) {
        console.log(kleur.dim(`Context estimate at ${postRollingPct}% — auto-compacting…`));
        await runAutoCompact(session);
      }

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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(kleur.red("✗ Error:"), message);
      session.messages.pop();
    }
  }

  await runHooks(session.hooks, "agentStop", { sessionId: session.id, cwd: process.cwd() });
  await shutdownMcp();
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

function applyModelRoute(session: Session, userInput: string): void {
  const route = resolveRoutedModel(session.creds, userInput, session.mode);
  if (route.modelName === session.modelName) return;

  session.modelName = route.modelName;
  session.languageModel = getModel(session.creds, route.modelName);
  console.log(
    kleur.dim(`Model route: ${route.taskClass} → ${route.modelName}`),
  );
}

async function announceProjectMcp(): Promise<void> {
  const cfg = await loadProjectMcpConfig();
  if (cfg.servers.length === 0) return;
  const names = cfg.servers.map((s) => s.name).join(", ");
  console.log(
    kleur.dim(
      `MCP project config found: ${getProjectMcpConfigPath()} → ${names}`,
    ),
  );
  console.log();
}

function describeMcpServer(server: MCPServer): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
  }
  return server.url ?? server.transport;
}

async function confirmProjectMcp(
  cfg: MCPConfig,
  prompt: (question: string) => Promise<string>,
): Promise<boolean> {
  const enabledServers = cfg.servers.filter((s) => s.enabled !== false);
  if (enabledServers.length === 0) return false;

  console.log(kleur.yellow("⚠"), kleur.bold("Project MCP servers are configured"));
  console.log(
    kleur.dim(
      "Project .mcp.json can run local commands. Only trust it if you trust this repository.",
    ),
  );
  for (const server of enabledServers) {
    console.log(
      kleur.dim(`  - ${server.name} (${server.transport}): ${describeMcpServer(server)}`),
    );
  }

  const answer = (
    await prompt(
      kleur.cyan("Start project MCP servers? ") + kleur.dim("[y/N] ") + "› ",
    )
  ).trim().toLowerCase();

  const trusted = answer === "y" || answer === "yes";
  if (!trusted) {
    console.log(kleur.dim("Skipped project MCP servers for this session."));
  }
  return trusted;
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
