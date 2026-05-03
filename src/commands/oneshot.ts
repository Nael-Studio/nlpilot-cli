import { stdout } from "node:process";
import { readFile } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { streamText, generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { resolveCredentials, DEFAULT_MODELS } from "../config.ts";
import { getModel } from "../providers.ts";
import { resolveRoutedModel } from "../model-router.ts";
import { getModelContextSize, listModels } from "../models.ts";
import { buildTools } from "../tools/index.ts";
import {
  createApprovalState,
  type ApprovalState,
  type PromptFn,
} from "../tools/approval.ts";
import {
  buildSystemPrompt,
  trimMessagesForSending,
  loadCustomization,
  type Session,
} from "../session.ts";
import {
  loadMostRecentSession,
  newSessionId,
  saveSession,
} from "../persistence.ts";
import { loadEffectiveMcpConfig, mergeAdditionalMcpConfig } from "../mcp.ts";
import { startMcpRuntime } from "../tools/mcp.ts";
import { startLoader, stopLoader, stopLoaderWithMessage } from "../ui/loader.ts";
import { buildCompactTranscript } from "./compact.ts";

export type OutputFormat = "text" | "json";

export interface OneShotOptions {
  prompt: string;
  compact?: boolean;
  model?: string;
  silent?: boolean;
  outputFormat?: OutputFormat;
  allowAll?: boolean;
  allow?: string[];
  deny?: string[];
  continueSession?: boolean;
  enableReasoningSummaries?: boolean;
  additionalMcpConfig?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  mcp?: boolean;
  modelRouting?: boolean;
  interactiveApprovals?: boolean;
  imageContextFile?: string;
}

interface ImageAttachment {
  name: string;
  mediaType: string;
  dataUrl: string;
}

interface JsonEvent {
  type:
    | "message"
    | "tool-call"
    | "tool-result"
    | "approval-request"
    | "text"
    | "usage"
    | "error"
    | "done";
  data?: unknown;
}

function emitJson(event: JsonEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function loadImageAttachments(path: string | undefined): Promise<ImageAttachment[]> {
  if (!path) return [];
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item): ImageAttachment[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.mediaType !== "string" ||
      typeof record.dataUrl !== "string" ||
      !record.mediaType.startsWith("image/") ||
      !record.dataUrl.startsWith("data:image/")
    ) {
      return [];
    }
    return [{ name: record.name, mediaType: record.mediaType, dataUrl: record.dataUrl }];
  });
}

function chooseSubtaskModel(provider: Session["creds"]["provider"], currentModel: string): string {
  const models = listModels(provider);
  if (models.length === 0) return currentModel;

  const preferred = [
    "nano",
    "haiku",
    "flash-lite",
    "flash",
    "mini",
  ];
  for (const marker of preferred) {
    const model = models.find((m) =>
      m.id.toLowerCase().includes(marker) ||
      m.label.toLowerCase().includes(marker) ||
      m.description?.toLowerCase().includes(marker),
    );
    if (model) return model.id;
  }

  return models.at(-1)?.id ?? currentModel;
}

function shouldAutoDelegateSubtask(prompt: string): boolean {
  const lower = prompt.toLowerCase().replaceAll(/\s+/g, " ").trim();
  return (
    /\b(?:what is|what's|explain|summari[sz]e|overview|understand|tell me)\b.*\b(?:project|repo|repository|codebase|app)\b/.test(lower) ||
    /\b(?:project|repo|repository|codebase|app)\b.*\b(?:doing|overview|structure|work|built|about)\b/.test(lower) ||
    /\b(?:outdated|out of date|newer versions?|package updates?|dependencies|dependency updates?)\b/.test(lower)
  );
}

function autoSubtask(prompt: string): { task: string; context: string[]; allowBash: boolean } {
  const lower = prompt.toLowerCase();
  if (/\b(?:outdated|out of date|newer versions?|package updates?|dependencies|dependency updates?)\b/.test(lower)) {
    return {
      task: [
        "Check which project dependencies are outdated and summarize the result.",
        "Inspect package manager metadata first, then run the appropriate non-mutating outdated/check command if needed.",
        "Do not modify files or install packages.",
        `User request: ${prompt}`,
      ].join(" "),
      context: ["package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
      allowBash: true,
    };
  }

  return {
    task: [
      "Inspect the project at a high level and summarize what it does.",
      "Focus on package metadata, README/docs, app entry points, routes, and major source folders.",
      `User request: ${prompt}`,
    ].join(" "),
    context: ["package.json", "README.md", "src/"],
    allowBash: false,
  };
}

async function runDelegatedSubtask(args: {
  creds: Session["creds"];
  parentModelName: string;
  task: string;
  context?: string[];
  model?: string;
  allowBash?: boolean;
  approvals: ApprovalState;
  prompt: PromptFn;
}): Promise<{
  task: string;
  modelName: string;
  summary: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
  const subtaskModel = args.model ??
    (args.creds.baseUrl ? args.parentModelName : chooseSubtaskModel(args.creds.provider, args.parentModelName));
  const subTools = buildTools({
    approvals: args.allowBash
      ? args.approvals
      : createApprovalState({ autopilot: true, nonInteractive: true, silentPrompts: true }),
    prompt: args.allowBash ? args.prompt : async () => "n",
    logToolCalls: false,
    viewedFiles: new Set<string>(),
    editedFiles: new Set<string>(),
    recorder: { record: () => undefined },
  });
  if (!args.allowBash) delete subTools.bash;
  delete subTools.edit;
  delete subTools.create;
  delete subTools.delegate_research;
  delete subTools.delegate_task;

  const contextText = args.context?.length
    ? `\n\nFocus context:\n${args.context.map((item) => `- ${item}`).join("\n")}`
    : "";
  const result = await generateText({
    model: getModel(args.creds, subtaskModel),
    system:
      "You are a delegated subtask agent for nlpilot. Do not modify files, install packages, or make final code changes. Use read/search/fetch tools, and use bash only for non-mutating inspection commands when available. Return a concise structured summary for the parent agent with: commands run, files inspected, key findings, risks, and recommended next steps. Include exact file paths and line ranges when relevant.",
    messages: [
      {
        role: "user",
        content: `Delegated task:\n${args.task}${contextText}`,
      },
    ],
    tools: subTools,
    stopWhen: stepCountIs(12),
    maxOutputTokens: 1_500,
  });

  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  return {
    task: args.task,
    modelName: subtaskModel,
    summary: result.text.trim(),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

export async function runOneShot(opts: OneShotOptions): Promise<number> {
  const creds = await resolveCredentials();
  if (!creds) {
    if (opts.outputFormat === "json") {
      emitJson({ type: "error", data: { message: "No credentials. Run nlpilot login." } });
    } else {
      console.error("✗ No credentials. Run `nlpilot login` first.");
    }
    return 1;
  }

  // ── Compact mode ─────────────────────────────────────────────────────────────
  // Load the most recent session, stream a summarization, then rewrite the
  // session messages on disk so the next --continue uses the compact context.
  if (opts.compact) {
    const prior = await loadMostRecentSession();
    if (!prior || prior.messages.length === 0) {
      if (opts.outputFormat === "json") {
        emitJson({ type: "text", data: "Nothing to compact." });
        emitJson({ type: "done" });
      } else {
        console.log("Nothing to compact.");
      }
      return 0;
    }

    const modelName = opts.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];
    const languageModel = getModel(creds, modelName);
    const isJson = opts.outputFormat === "json";
    const isSilent = opts.silent ?? false;
    const transcript = buildCompactTranscript(prior.messages);

    if (!isJson && !isSilent) startLoader("Compacting...");
    const result = await generateText({
      model: languageModel,
      system: "You are a conversation summarizer. Produce a concise but information-dense summary of the prior assistant/user turns. Preserve decisions, file paths touched, code changes made, and open TODOs. Do not invent details. Reply with only the summary text.",
      messages: [{ role: "user", content: `Summarize the following conversation:\n\n${transcript}` }],
    });
    if (!isJson && !isSilent) stopLoader();

    const summaryText = result.text.trim();
    if (summaryText) {
      await saveSession({
        ...prior,
        messages: [
          { role: "user", content: `Summary of prior conversation:\n${summaryText}` },
          { role: "assistant", content: "Acknowledged. Continuing from this summary." },
        ],
        updatedAt: Date.now(),
      });
    }

    if (isJson) {
      emitJson({ type: "text", data: "Conversation compacted." });
      emitJson({
        type: "usage",
        data: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
          totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          cumulativeInputTokens: result.usage.inputTokens ?? 0,
          cumulativeOutputTokens: result.usage.outputTokens ?? 0,
          cumulativeTotalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          sessionId: prior.id,
          modelName,
          provider: creds.provider,
        },
      });
      emitJson({ type: "done" });
    } else {
      console.log("✓ Conversation compacted.");
    }
    return 0;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const explicitModel = Boolean(opts.model || process.env.NLPILOT_MODEL);
  const shouldRouteModel = opts.modelRouting !== false && !explicitModel && !creds.baseUrl;
  const modelName = shouldRouteModel
    ? resolveRoutedModel(creds, opts.prompt, opts.allowAll ? "autopilot" : "ask").modelName
    : opts.model ?? creds.model ?? DEFAULT_MODELS[creds.provider];

  // Restore prior conversation if --continue
  let priorMessages: Session["messages"] = [];
  let priorId: string | undefined;
  let priorCreatedAt: number | undefined;
  let priorInputTokens = 0;
  let priorOutputTokens = 0;
  if (opts.continueSession) {
    const prior = await loadMostRecentSession();
    if (prior) {
      priorMessages = prior.messages;
      priorId = prior.id;
      priorCreatedAt = prior.createdAt;
      priorInputTokens = prior.cumulativeInputTokens ?? 0;
      priorOutputTokens = prior.cumulativeOutputTokens ?? 0;
    }
  }

  const customization = await loadCustomization();
  const session: Session = {
    id: priorId ?? newSessionId(),
    createdAt: priorCreatedAt ?? Date.now(),
    creds,
    modelName,
    languageModel: getModel(creds, modelName),
    messages: priorMessages,
    mode: opts.allowAll ? "autopilot" : "ask",
    theme: "default",
    turn: 0,
    fileChanges: [],
    lastAssistantText: "",
    instructions: customization.instructions,
    agents: customization.agents,
    skills: customization.skills,
    hooks: customization.hooks,
    enableReasoningSummaries: opts.enableReasoningSummaries,
    additionalMcpConfig: opts.additionalMcpConfig,
    cumulativeInputTokens: priorInputTokens,
    cumulativeOutputTokens: priorOutputTokens,
  };

  const approvals: ApprovalState = createApprovalState({
    autopilot: opts.allowAll,
    allow: opts.allow,
    deny: opts.deny,
    nonInteractive: !opts.interactiveApprovals,
    silentPrompts: opts.outputFormat === "json",
  });

  let approvalReader: readline.Interface | undefined;
  const promptFn = async (
    _question: string,
    request?: { toolName: string; summary: string; details?: string },
  ): Promise<string> => {
    if (!opts.interactiveApprovals || !request) return "n";

    if (opts.outputFormat === "json") {
      emitJson({
        type: "approval-request",
        data: {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          toolName: request.toolName,
          summary: request.summary,
          details: request.details,
        },
      });
    }

    approvalReader ??= readline.createInterface({
      input: process.stdin,
      output: undefined,
      terminal: false,
    });
    return await approvalReader.question("");
  };

  const tools = buildTools({
    approvals,
    prompt: promptFn,
    logToolCalls: opts.outputFormat !== "json" && opts.silent !== true,
    viewedFiles: new Set<string>(),
    editedFiles: new Set<string>(),
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

  tools.delegate_research = tool({
    description:
      "Spawn an isolated read-only research subtask to inspect files or gather focused context. Use this when the main task would otherwise need many grep/view calls. The subtask cannot edit files or run shell commands.",
    inputSchema: z.object({
      task: z.string().min(1).describe("Specific research question for the subtask."),
      context: z.array(z.string()).max(20).optional().describe("Relevant files, folders, symbols, or constraints to focus the subtask."),
      model: z.string().optional().describe("Optional cheaper model override for this research subtask."),
    }),
    execute: async ({ task, context, model }) => {
      return await runDelegatedSubtask({
        creds,
        parentModelName: modelName,
        task,
        context,
        model,
        allowBash: false,
        approvals,
        prompt: promptFn,
      });
    },
  });

  tools.delegate_task = tool({
    description:
      "Spawn an isolated subtask for a smaller investigation. It can read/search/fetch and may run non-mutating bash commands such as dependency checks or test discovery, but it cannot edit or create files.",
    inputSchema: z.object({
      task: z.string().min(1).describe("Specific subtask for the delegated agent."),
      context: z.array(z.string()).max(20).optional().describe("Relevant files, folders, commands, or constraints to focus the subtask."),
      allowBash: z.boolean().optional().describe("Allow non-mutating bash commands inside the subtask when needed."),
      model: z.string().optional().describe("Optional cheaper model override for this subtask."),
    }),
    execute: async ({ task, context, allowBash, model }) => {
      return await runDelegatedSubtask({
        creds,
        parentModelName: modelName,
        task,
        context,
        model,
        allowBash: Boolean(allowBash),
        approvals,
        prompt: promptFn,
      });
    },
  });

  let shutdownMcp = async (): Promise<void> => undefined;
  if (opts.mcp !== false) {
    // Bring up MCP runtime (global + project .mcp.json + additional) and merge its tools.
    let mcpConfig = await loadEffectiveMcpConfig();
    mcpConfig = await mergeAdditionalMcpConfig(mcpConfig, opts.additionalMcpConfig);
    const mcp = await startMcpRuntime(mcpConfig.servers, {
      approvals,
      prompt: promptFn,
    });
    Object.assign(tools, mcp.tools);
    shutdownMcp = mcp.shutdown;
  }

  session.turn += 1;

  const isJson = opts.outputFormat === "json";
  const isSilent = opts.silent ?? false;

  try {
    let userPrompt = opts.prompt;
    const imageAttachments = await loadImageAttachments(opts.imageContextFile);
    if (shouldAutoDelegateSubtask(opts.prompt)) {
      const subtaskInput = autoSubtask(opts.prompt);
      if (isJson) {
        emitJson({
          type: "tool-call",
          data: { toolName: "delegate_task", input: subtaskInput },
        });
      } else if (!isSilent) {
        process.stderr.write("\n  -> delegate_task\n");
      }

      const subtaskResult = await runDelegatedSubtask({
        creds,
        parentModelName: modelName,
        task: subtaskInput.task,
        context: subtaskInput.context,
        allowBash: subtaskInput.allowBash,
        approvals,
        prompt: promptFn,
      });

      if (isJson) {
        emitJson({
          type: "tool-result",
          data: { toolName: "delegate_task", output: subtaskResult },
        });
      }

      userPrompt +=
        "\n\n--- Delegated subtask summary ---\n" +
        `Model: ${subtaskResult.modelName}\n` +
        subtaskResult.summary;
    }

    const userMessageContent = imageAttachments.length > 0
      ? [
          { type: "text" as const, text: userPrompt },
          ...imageAttachments.map((image) => ({
            type: "image" as const,
            image: image.dataUrl,
            mediaType: image.mediaType,
          })),
        ]
      : userPrompt;
    session.messages.push({ role: "user", content: userMessageContent });

    if (!isJson && !isSilent) {
      startLoader("Thinking...");
    }
    const result = streamText({
      model: session.languageModel,
      system: buildSystemPrompt(session, { latestUserMessage: userPrompt }),
      messages: trimMessagesForSending(session.messages),
      tools,
      stopWhen: stepCountIs(opts.maxSteps ?? 100),
      maxOutputTokens: opts.maxOutputTokens,
    });

    let assistantText = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        if (!isJson && !isSilent) stopLoader();
        assistantText += part.text;
        if (isJson) {
          emitJson({ type: "text", data: part.text });
        } else {
          stdout.write(part.text);
        }
      } else if (part.type === "tool-call") {
        if (isJson) {
          emitJson({
            type: "tool-call",
            data: { toolName: part.toolName, input: part.input },
          });
        } else if (!isSilent) {
          stopLoader();
          process.stderr.write(`\n  → ${part.toolName}\n`);
          startLoader(`Running ${part.toolName}...`);
        }
      } else if (part.type === "tool-result") {
        if (!isJson && !isSilent) stopLoader();
        if (isJson) {
          emitJson({
            type: "tool-result",
            data: { toolName: part.toolName, output: part.output },
          });
        }
      } else if (part.type === "error") {
        stopLoader();
        let message: string;
        if (part.error instanceof Error) message = part.error.message;
        else if (typeof part.error === "object" && part.error !== null)
          message = JSON.stringify(part.error);
        else message = String(part.error);
        if (isJson) emitJson({ type: "error", data: { message } });
        else process.stderr.write(`\n✗ ${message}\n`);
      }
    }

    if (!isJson) stdout.write("\n");
    session.lastAssistantText = assistantText;
    const [response, usage] = await Promise.all([result.response, result.totalUsage]);
    const responseMessages = response.messages;
    if (imageAttachments.length > 0) {
      const lastUser = session.messages.findLast((message) => message.role === "user");
      if (lastUser) {
        lastUser.content =
          `${userPrompt}\n\n[${imageAttachments.length} image attachment${imageAttachments.length === 1 ? "" : "s"} omitted from saved session.]`;
      }
    }
    session.messages.push(...responseMessages);
    session.cumulativeInputTokens += usage.inputTokens ?? 0;
    session.cumulativeOutputTokens += usage.outputTokens ?? 0;

    await saveSession({
      id: session.id,
      cwd: process.cwd(),
      modelName,
      provider: creds.provider,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
      messages: session.messages,
      cumulativeInputTokens: session.cumulativeInputTokens,
      cumulativeOutputTokens: session.cumulativeOutputTokens,
    });

    if (isJson) {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const contextSize = getModelContextSize(creds.provider, modelName);
      const cumulativeTotalTokens =
        session.cumulativeInputTokens + session.cumulativeOutputTokens;
      emitJson({
        type: "usage",
        data: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cumulativeInputTokens: session.cumulativeInputTokens,
          cumulativeOutputTokens: session.cumulativeOutputTokens,
          cumulativeTotalTokens,
          contextSize,
          contextPercentage: contextSize > 0
            ? (cumulativeTotalTokens / contextSize) * 100
            : undefined,
          modelName,
          provider: creds.provider,
          sessionId: session.id,
          isEstimate: false,
        },
      });
    }

    if (isJson) emitJson({ type: "done" });
    approvalReader?.close();
    await shutdownMcp();
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isJson) emitJson({ type: "error", data: { message } });
    else console.error("✗ Error:", message);
    approvalReader?.close();
    await shutdownMcp();
    return 1;
  }
}
