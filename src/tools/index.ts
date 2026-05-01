import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import kleur from "kleur";
import { Glob } from "bun";
import {
  requestApproval,
  type ApprovalState,
  type PromptFn,
} from "./approval.ts";
import type { FileChange } from "../session.ts";

export interface FileChangeRecorder {
  record: (change: Omit<FileChange, "turn" | "timestamp">) => void;
}

const MAX_OUTPUT = 8_000;   // bash stdout/stderr cap per call
const VIEW_DEFAULT_LINES = 80;  // default lines returned by view (no range given)
const VIEW_MAX_BYTES = 6_000;   // hard byte cap on view output

const REGEX_META = new RegExp(String.raw`[.*+?^${"$"}{}()|[\]\\]`, "g");

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

function resolveInsideCwd(p: string): string {
  const abs = path.resolve(process.cwd(), p);
  return abs;
}

interface ToolDeps {
  approvals: ApprovalState;
  prompt: PromptFn;
  recorder: FileChangeRecorder;
}

function logToolCall(name: string, summary: string): void {
  console.log(kleur.dim(`  ⚙ ${name}: ${summary}`));
}

export function buildTools(deps: ToolDeps): ToolSet {
  const { approvals, prompt, recorder } = deps;

  return {
    bash: tool({
      description:
        "Execute a shell command. Always asks the user for approval first. Returns combined stdout/stderr and the exit code.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute via /bin/sh -c"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory (defaults to current cwd)"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional timeout in milliseconds"),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        const decision = await requestApproval(approvals, prompt, {
          toolName: "bash",
          summary: `Run: ${command}`,
          details: cwd ? `cwd: ${cwd}` : undefined,
        });
        if (decision === "deny") {
          return { denied: true, message: "User denied execution" };
        }
        return await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number | null;
          timedOut?: boolean;
        }>((resolve) => {
          const child = spawn("/bin/sh", ["-c", command], {
            cwd: cwd ?? process.cwd(),
            env: process.env,
          });
          let stdout = "";
          let stderr = "";
          let timedOut = false;
          const timer = timeoutMs
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
              }, timeoutMs)
            : null;
          child.stdout.on("data", (d) => {
            stdout += d.toString();
          });
          child.stderr.on("data", (d) => {
            stderr += d.toString();
          });
          child.on("close", (code) => {
            if (timer) clearTimeout(timer);
            resolve({
              stdout: truncate(stdout),
              stderr: truncate(stderr),
              exitCode: code,
              timedOut: timedOut || undefined,
            });
          });
          child.on("error", (err) => {
            if (timer) clearTimeout(timer);
            resolve({
              stdout,
              stderr: stderr + "\n" + err.message,
              exitCode: -1,
            });
          });
        });
      },
    }),

    view: tool({
      description:
        "Read a slice of a file or list a directory. ALWAYS prefer narrow line ranges over whole-file reads. Without a range, only the first 200 lines (capped at ~16KB) are returned with a `totalLines` hint so you can request more.",
      inputSchema: z.object({
        path: z.string().describe("Relative or absolute path"),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based start line (files only)"),
        endLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based inclusive end line (files only)"),
        maxLines: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe("Cap on number of lines returned (default 200)"),
      }),
      execute: async ({ path: p, startLine, endLine, maxLines }) => {
        const abs = resolveInsideCwd(p);
        logToolCall("view", abs);
        try {
          const stat = await fs.stat(abs);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(abs, { withFileTypes: true });
            return {
              type: "directory",
              path: abs,
              entries: entries.map((e) => ({
                name: e.name + (e.isDirectory() ? "/" : ""),
                isDirectory: e.isDirectory(),
              })),
            };
          }
          const content = await fs.readFile(abs, "utf8");
          const lines = content.split("\n");
          const totalLines = lines.length;
          const cap = Math.min(maxLines ?? VIEW_DEFAULT_LINES, 2000);
          const s = (startLine ?? 1) - 1;
          const requestedEnd = endLine ?? s + cap;
          const e = Math.min(requestedEnd, s + cap, totalLines);
          const slice = lines.slice(s, e).join("\n");
          const truncatedBytes = slice.length > VIEW_MAX_BYTES;
          const body = truncatedBytes ? slice.slice(0, VIEW_MAX_BYTES) : slice;
          return {
            type: "file",
            path: abs,
            startLine: s + 1,
            endLine: e,
            totalLines,
            content: body,
            truncated: truncatedBytes || e < totalLines,
            hint:
              e < totalLines
                ? `Showed lines ${s + 1}-${e} of ${totalLines}. Call view again with startLine=${e + 1} for more.`
                : undefined,
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    edit: tool({
      description:
        "Edit a file by replacing an exact string with a new string. The oldString must appear exactly once. Asks for user approval.",
      inputSchema: z.object({
        path: z.string(),
        oldString: z.string().describe("Exact text to replace; must be unique"),
        newString: z.string().describe("Replacement text"),
      }),
      execute: async ({ path: p, oldString, newString }) => {
        const abs = resolveInsideCwd(p);
        let content: string;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch (err) {
          return {
            error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const idx = content.indexOf(oldString);
        if (idx === -1) return { error: "oldString not found in file" };
        if (content.includes(oldString, idx + 1)) {
          return { error: "oldString matches multiple locations; make it unique" };
        }
        const decision = await requestApproval(approvals, prompt, {
          toolName: "edit",
          summary: `Edit ${path.relative(process.cwd(), abs) || abs}`,
          details: `- ${oldString.split("\n").slice(0, 3).join("\n- ")}\n+ ${newString.split("\n").slice(0, 3).join("\n+ ")}`,
        });
        if (decision === "deny")
          return { denied: true, message: "User denied edit" };
        const next = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
        await fs.writeFile(abs, next, "utf8");
        recorder.record({ path: abs, before: content, after: next, tool: "edit" });
        return { ok: true, path: abs, bytes: next.length };
      },
    }),

    create: tool({
      description:
        "Create a new file with the given content. Fails if the file already exists. Asks for user approval.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => {
        const abs = resolveInsideCwd(p);
        try {
          await fs.access(abs);
          return { error: "File already exists" };
        } catch {
          // ok, doesn't exist
        }
        const decision = await requestApproval(approvals, prompt, {
          toolName: "create",
          summary: `Create ${path.relative(process.cwd(), abs) || abs}`,
          details: `${content.length} bytes`,
        });
        if (decision === "deny")
          return { denied: true, message: "User denied create" };
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        recorder.record({ path: abs, before: null, after: content, tool: "create" });
        return { ok: true, path: abs, bytes: content.length };
      },
    }),

    glob: tool({
      description:
        "Find files matching a glob pattern, relative to the current working directory. Examples: 'src/**/*.ts', '**/*.md'.",
      inputSchema: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
      execute: async ({ pattern, cwd, limit }) => {
        const base = cwd ? resolveInsideCwd(cwd) : process.cwd();
        logToolCall("glob", `${pattern} @ ${base}`);
        const glob = new Glob(pattern);
        const results: string[] = [];
        const max = limit ?? 200;
        for await (const match of glob.scan({ cwd: base, onlyFiles: true })) {
          results.push(match);
          if (results.length >= max) break;
        }
        return { pattern, cwd: base, count: results.length, files: results };
      },
    }),

    grep: tool({
      description:
        "Search for a regex or literal string in files matching a glob pattern. Returns matching lines with file paths and line numbers, plus optional surrounding context. Use this to locate code, then `view` only the narrow line range you need.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex or literal text to search for"),
        glob: z.string().optional().describe("File glob (default: '**/*')"),
        regex: z.boolean().optional().describe("Treat pattern as regex (default: false)"),
        ignoreCase: z.boolean().optional(),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe("Lines of context around each match (default 0)"),
        maxMatches: z.number().int().positive().max(2000).optional(),
      }),
      execute: async ({ pattern, glob, regex, ignoreCase, contextLines, maxMatches }) => {
        const base = process.cwd();
        const g = new Glob(glob ?? "**/*");
        let re: RegExp;
        try {
          const flags = ignoreCase ? "i" : "";
          re = regex
            ? new RegExp(pattern, flags)
            : new RegExp(
                pattern.replaceAll(REGEX_META, String.raw`\$&`),
                flags,
              );
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        const limit = maxMatches ?? 200;
        const ctx = contextLines ?? 0;
        const matches: Array<{
          file: string;
          line: number;
          text: string;
          context?: string[];
        }> = [];
        outer: for await (const file of g.scan({
          cwd: base,
          onlyFiles: true,
        })) {
          let content: string;
          try {
            content = await fs.readFile(path.join(base, file), "utf8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i] ?? "";
            if (re.test(lineText)) {
              const entry: { file: string; line: number; text: string; context?: string[] } = {
                file,
                line: i + 1,
                text: lineText.slice(0, 300),
              };
              if (ctx > 0) {
                const start = Math.max(0, i - ctx);
                const end = Math.min(lines.length, i + ctx + 1);
                entry.context = lines
                  .slice(start, end)
                  .map((l, j) => `${start + j + 1}: ${l.slice(0, 300)}`);
              }
              matches.push(entry);
              if (matches.length >= limit) break outer;
            }
          }
        }
        return { pattern, count: matches.length, matches };
      },
    }),

    web_fetch: tool({
      description:
        "Fetch a URL and return its text content (HTML stripped to plain text). Asks for user approval.",
      inputSchema: z.object({
        url: z.url(),
        method: z.enum(["GET", "POST"]).optional(),
      }),
      execute: async ({ url, method }) => {
        const decision = await requestApproval(approvals, prompt, {
          toolName: "web_fetch",
          summary: `Fetch ${method ?? "GET"} ${url}`,
        });
        if (decision === "deny")
          return { denied: true, message: "User denied fetch" };
        try {
          const res = await fetch(url, { method: method ?? "GET" });
          const contentType = res.headers.get("content-type") ?? "";
          let body = await res.text();
          if (contentType.includes("html")) {
            body = body
              .replaceAll(/<script[\s\S]*?<\/script>/gi, "")
              .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
              .replaceAll(/<[^>]+>/g, " ")
              .replaceAll(/\s+/g, " ")
              .trim();
          }
          return {
            url,
            status: res.status,
            contentType,
            body: truncate(body),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  } satisfies ToolSet;
}
