#!/usr/bin/env bun
import { Command, InvalidArgumentError, Option } from "commander";
import kleur from "kleur";
import pkg from "../package.json" with { type: "json" };
import { loginCommand } from "./commands/login.ts";
import { logoutCommand } from "./commands/logout.ts";
import { startRepl } from "./commands/repl.ts";
import { helpCommand } from "./commands/help.ts";
import { modelsCommand } from "./commands/models.ts";
import { runOneShot, type OutputFormat } from "./commands/oneshot.ts";
import { initCommand } from "./commands/init.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { ensureConfigDir } from "./config.ts";

interface RootOptions {
  model?: string;
  prompt?: string;
  silent?: boolean;
  outputFormat?: OutputFormat;
  allowAllTools?: boolean;
  allowAll?: boolean;
  noAskUser?: boolean;
  enableReasoningSummaries?: boolean;
  additionalMcpConfig?: string;
  allowTool?: string[];
  denyTool?: string[];
  continue?: boolean;
  maxSteps?: number;
  maxOutputTokens?: number;
  mcp?: boolean;
  compactThreshold?: number;
  modelRouting?: boolean;
  autoCompact?: boolean;
  compact?: boolean;
  interactiveApprovals?: boolean;
}

function collect(value: string, prev: string[] = []): string[] {
  return prev.concat(value.split(",").map((v) => v.trim()).filter(Boolean));
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Must be a positive integer");
  }
  return parsed;
}

function parsePercentage(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    throw new InvalidArgumentError("Must be a number from 1 to 100");
  }
  return parsed;
}

const program = new Command();

program
  .name("nlpilot")
  .description("A CLI clone of GitHub Copilot CLI powered by the Vercel AI SDK")
  .version(pkg.version, "-v, --version", "Print version")
  .option("-m, --model <model>", "Override the default model for this run")
  .option("-p, --prompt <prompt>", "Run a single prompt non-interactively, then exit")
  .option("-s, --silent", "Output only the agent response (no banners or tool logs)")
  .addOption(
    new Option(
      "--output-format <format>",
      "Output format for non-interactive mode",
    )
      .choices(["text", "json"])
      .default("text"),
  )
  .option("--allow-all-tools", "Skip approval prompts (autopilot mode)")
  .option("--allow-all", "Alias for --allow-all-tools")
  .option("--no-ask-user", "Do not ask for user confirmation (autopilot mode)")
  .option("--enable-reasoning-summaries", "Show reasoning/thinking summaries from the model")
  .option("--additional-mcp-config <path>", "Load additional MCP servers from a file")
  .option("--max-steps <n>", "Maximum model/tool loop steps per prompt", parsePositiveInteger)
  .option("--max-output-tokens <n>", "Maximum assistant output tokens", parsePositiveInteger)
  .option("--no-mcp", "Disable all MCP servers for this run")
  .option("--no-model-routing", "Disable automatic cheap/balanced/reasoning model routing")
  .option("--no-auto-compact", "Disable rolling REPL compaction after each turn")
  .option(
    "--compact-threshold <pct>",
    "Auto-compact REPL context when estimated usage exceeds this percent",
    parsePercentage,
  )
  .option(
    "--allow-tool <tool>",
    "Always allow the named tool (repeatable, comma-separated)",
    collect,
    [] as string[],
  )
  .option(
    "--deny-tool <tool>",
    "Deny the named tool (repeatable, comma-separated)",
    collect,
    [] as string[],
  )
  .option("--continue", "Resume the most recent session in this cwd")
  .option("--compact", "Summarize and compact the most recent session, then exit")
  .option("--interactive-approvals", "Read tool approval decisions from stdin in JSON one-shot mode")
  .action(async (opts: RootOptions) => {
    const allowAll = Boolean(opts.allowAllTools ?? opts.allowAll ?? opts.noAskUser);
    const allow = opts.allowTool ?? [];
    const deny = opts.denyTool ?? [];

    if (opts.compact) {
      const code = await runOneShot({
        prompt: "",
        model: opts.model,
        silent: opts.silent,
        outputFormat: opts.outputFormat ?? "text",
        allowAll,
        allow,
        deny,
        compact: true,
        mcp: false,
        modelRouting: opts.modelRouting !== false,
        interactiveApprovals: opts.interactiveApprovals,
      });
      process.exit(code);
    }

    if (opts.prompt) {
      const code = await runOneShot({
        prompt: opts.prompt,
        model: opts.model,
        silent: opts.silent,
        outputFormat: opts.outputFormat ?? "text",
        allowAll,
        allow,
        deny,
        continueSession: opts.continue,
        enableReasoningSummaries: opts.enableReasoningSummaries,
        additionalMcpConfig: opts.additionalMcpConfig,
        maxSteps: opts.maxSteps,
        maxOutputTokens: opts.maxOutputTokens,
        mcp: opts.mcp !== false,
        modelRouting: opts.modelRouting !== false,
        interactiveApprovals: opts.interactiveApprovals,
      });
      process.exit(code);
    }

    await startRepl({
      model: opts.model,
      continueSession: opts.continue,
      allowAll,
      allow,
      deny,
      maxSteps: opts.maxSteps,
      maxOutputTokens: opts.maxOutputTokens,
      mcp: opts.mcp !== false,
      compactThreshold: opts.compactThreshold,
      modelRouting: opts.modelRouting !== false,
      autoCompact: opts.autoCompact !== false,
    });
  });

program
  .command("login")
  .description("Prompt for an API key and store it under ~/.nlpilot/credentials")
  .action(async () => {
    await loginCommand();
  });

program
  .command("logout")
  .description("Clear stored API key")
  .action(async () => {
    await logoutCommand();
  });

program
  .command("version")
  .description("Print version info")
  .action(() => {
    console.log(`nlpilot v${pkg.version}`);
  });

program
  .command("help [topic]")
  .description("Display help; topics: config, commands, environment, permissions")
  .action((topic?: string) => {
    helpCommand(topic);
  });

program
  .command("models [provider]")
  .description("List known models. Optional provider: openai | anthropic | google")
  .action(async (provider?: string) => {
    await modelsCommand(provider);
  });

program
  .command("init")
  .description("Analyze the repo and write .nlpilot/instructions.md")
  .action(async () => {
    await initCommand();
  });

program
  .command("mcp [action] [name]")
  .description("Manage MCP servers: list | get <name> | add [name] | remove <name>")
  .action(async (action?: string, name?: string) => {
    await mcpCommand(action, name);
  });

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) return JSON.stringify(err);
  return String(err);
}

try {
  // Initialize config directory and load models catalog
  await ensureConfigDir();
  
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  console.error(kleur.red("✗"), formatError(err));
  process.exit(1);
}
