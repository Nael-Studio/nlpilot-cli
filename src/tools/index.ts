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
const MAX_GREP_OUTPUT = 16_000; // total chars across all grep matches

const REGEX_META = new RegExp(String.raw`[.*+?^${"$"}{}()|[\]\\]`, "g");

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

function resolveInsideCwd(p: string): string {
  const base = process.cwd();
  const abs = path.resolve(base, p);
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new TypeError(`Path "${p}" escapes the working directory`);
  }
  return abs;
}

interface ToolDeps {
  approvals: ApprovalState;
  prompt: PromptFn;
  recorder: FileChangeRecorder;
  /** Tracks which absolute paths have been viewed this turn. Reset between turns. */
  viewedFiles: Set<string>;
  /** Tracks which absolute paths were edited/created this turn (allows re-view after edit). */
  editedFiles: Set<string>;
}

function logToolCall(name: string, summary: string): void {
  console.log(kleur.dim(`  ⚙ ${name}: ${summary}`));
}

const MAX_VIEW_LINES = 200; // max lines returned by the view tool per call

export function buildTools(deps: ToolDeps): ToolSet {
  const { approvals, prompt, recorder, viewedFiles, editedFiles } = deps;

  return {
    view: tool({
      description:
        "Read lines from a file. Returns at most 200 lines. " +
        "Choose a wide range that covers everything you need — do NOT call view multiple times on the same file. " +
        "Omit startLine/endLine to read the first 200 lines.",
      inputSchema: z.object({
        path: z.string(),
        startLine: z.number().int().min(1).optional().describe("1-based inclusive start line"),
        endLine: z.number().int().min(1).optional().describe("1-based inclusive end line"),
      }),
      execute: async ({ path: p, startLine, endLine }) => {
        let abs: string;
        try { abs = resolveInsideCwd(p); } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        logToolCall("view", `${p}${startLine != null ? ` L${startLine}-${endLine ?? "…"}` : ""}`);
        // Reject directory paths — use grep with filenamesOnly:true for listings.
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try { stat = await fs.stat(abs); } catch (err) {
          return { error: `Cannot stat path: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (stat.isDirectory()) {
          return { error: `"${p}" is a directory. Use grep with filenamesOnly:true to list its contents.` };
        }
        // Reject re-reads unless the file was edited this turn.
        if (viewedFiles.has(abs) && !editedFiles.has(abs)) {
          return {
            error: `Already read "${p}" this turn. Use the content from the previous view result instead of re-reading.`,
          };
        }
        viewedFiles.add(abs);
        let content: string;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch (err) {
          return { error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
        }
        const lines = content.split("\n");
        const total = lines.length;
        const s = Math.max(1, startLine ?? 1);
        // Enforce a minimum read of MIN_VIEW_LINES lines so the model can't
        // request tiny slices and then loop with follow-up calls.
        const MIN_VIEW_LINES = 150;
        const requestedEnd = endLine != null ? Math.min(total, endLine) : total;
        const enforcedEnd = Math.max(requestedEnd, Math.min(total, s + MIN_VIEW_LINES - 1));
        const capped = Math.min(enforcedEnd, s + MAX_VIEW_LINES - 1);
        const slice = lines
          .slice(s - 1, capped)
          .map((l, i) => `${s + i}: ${l}`)
          .join("\n");
        return {
          path: p,
          startLine: s,
          endLine: capped,
          totalLines: total,
          content: slice,
          ...(capped < enforcedEnd
            ? { note: `Capped at ${MAX_VIEW_LINES} lines. Call again with startLine: ${capped + 1} for more.` }
            : capped < total
              ? { note: `File has ${total} lines total. Use startLine/endLine to read other sections.` }
              : undefined),
        };
      },
    }),

    bash: tool({
      description:
        "Run a shell command. Use ONLY for computation, compilation, running tests, or operations that have no dedicated tool. " +
        "Do NOT use for: file discovery (use grep filenamesOnly:true), reading files (use view), searching text (use grep).",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
      }),
      execute: async ({ command, cwd }) => {
        // Reject commands that should use dedicated tools instead.
        const trimmed = command.trimStart();
        const BANNED = [
          { re: /^(ls|ls\s)/, alt: "grep with filenamesOnly:true" },
          { re: /^find\s/, alt: "grep with filenamesOnly:true" },
          { re: /^cat\s/, alt: "the view tool" },
          { re: /^head\s/, alt: "the view tool with startLine/endLine" },
          { re: /^tail\s/, alt: "the view tool with startLine/endLine" },
          { re: /^wc\s/, alt: "the view tool (check totalLines in response)" },
          { re: /^grep\s/, alt: "the grep tool" },
          { re: /^sed\s+-n\s+['"]?\d/, alt: "the view tool with startLine/endLine" },
          { re: /^glob\s/, alt: "grep with filenamesOnly:true" },
        ];
        for (const { re, alt } of BANNED) {
          if (re.test(trimmed)) {
            return {
              error: `This command is not allowed via bash. Use ${alt} instead.`,
              bannedCommand: command,
            };
          }
        }
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
        }>((resolve) => {
          const child = spawn("/bin/sh", ["-c", command], {
            cwd: cwd ?? process.cwd(),
            env: process.env,
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => { stdout += d.toString(); });
          child.stderr.on("data", (d) => { stderr += d.toString(); });
          child.on("close", (code) => {
            resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code });
          });
          child.on("error", (err) => {
            resolve({ stdout, stderr: stderr + "\n" + err.message, exitCode: -1 });
          });
        });
      },
    }),

    edit: tool({
      description: "Replace unique oldString with newString in a file.",
      inputSchema: z.object({
        path: z.string(),
        oldString: z.string().describe("Must appear exactly once in the file"),
        newString: z.string(),
      }),
      execute: async ({ path: p, oldString, newString }) => {
        let abs: string;
        try { abs = resolveInsideCwd(p); } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
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
        editedFiles.add(abs);
        viewedFiles.delete(abs); // allow re-read after edit
        return { ok: true, path: abs, bytes: next.length };
      },
    }),

    create: tool({
      description: "Create a new file. Fails if the file already exists.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => {
        let abs: string;
        try { abs = resolveInsideCwd(p); } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
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
        editedFiles.add(abs);
        return { ok: true, path: abs, bytes: content.length };
      },
    }),

    grep: tool({
      description: "Search file content by pattern. Set filenamesOnly:true to list files matching a name glob instead (replaces glob tool).",
      inputSchema: z.object({
        pattern: z.string().describe("Content pattern, or filename glob when filenamesOnly:true"),
        glob: z.string().optional(),
        regex: z.boolean().optional(),
        ignoreCase: z.boolean().optional(),
        contextLines: z.number().int().min(0).max(10).optional(),
        filenamesOnly: z.boolean().optional(),
      }),
      execute: async ({ pattern, glob, regex, ignoreCase, contextLines, filenamesOnly }) => {
        const base = process.cwd();

        if (filenamesOnly) {
          logToolCall("grep/files", pattern);
          const g = new Glob(pattern);
          const results: string[] = [];
          for await (const file of g.scan({ cwd: base, onlyFiles: true })) {
            results.push(file);
            if (results.length >= 200) break;
          }
          return { pattern, count: results.length, files: results };
        }

        logToolCall("grep", `"${pattern}" in ${glob ?? "**/*"}`);
        const g = new Glob(glob ?? "**/*");
        let re: RegExp;
        try {
          const flags = ignoreCase ? "i" : "";
          re = regex
            ? new RegExp(pattern, flags)
            : new RegExp(pattern.replaceAll(REGEX_META, String.raw`\$&`), flags);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        const ctx = contextLines ?? 0;
        const matches: Array<{
          file: string;
          line: number;
          text: string;
          context?: string[];
        }> = [];
        let totalChars = 0;
        outer: for await (const file of g.scan({ cwd: base, onlyFiles: true })) {
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
              totalChars += entry.text.length + (entry.context?.join("").length ?? 0);
              if (matches.length >= 200 || totalChars >= MAX_GREP_OUTPUT) break outer;
            }
          }
        }
        const truncatedBySize = totalChars >= MAX_GREP_OUTPUT;
        return {
          pattern,
          count: matches.length,
          matches,
          ...(truncatedBySize
            ? { note: `Output cap reached (${MAX_GREP_OUTPUT} chars). Results are partial — use a more specific pattern or glob.` }
            : matches.length >= 200
              ? { note: `Match cap reached (200). Consider a more specific pattern or glob.` }
              : matches.length > 50
                ? { note: `Large result set (${matches.length} matches). Consider a more specific pattern or glob.` }
                : undefined),
        };
      },
    }),

    web_fetch: tool({
      description: "Fetch a URL and return its text (HTML stripped to plain text). Only public URLs are allowed.",
      inputSchema: z.object({
        url: z.url(),
        method: z.enum(["GET", "POST"]).optional(),
      }),
      execute: async ({ url, method }) => {
        // SSRF guard: block requests to private/loopback networks
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
        } catch {
          return { error: "Invalid URL" };
        }
        const hostname = parsedUrl.hostname.toLowerCase();
        const PRIVATE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|fc00:|fe80:|0\.0\.0\.0|169\.254\.)/;
        if (PRIVATE.test(hostname)) {
          return { error: "Requests to private/loopback addresses are not allowed" };
        }
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
          return { url, status: res.status, contentType, body: truncate(body) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  } satisfies ToolSet;
}
