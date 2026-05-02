import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import * as fs from "node:fs/promises";
import { isIP } from "node:net";
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

const MAX_OUTPUT = 4_000;   // bash stdout/stderr cap per call
const MAX_GREP_OUTPUT = 8_000; // total chars across all grep matches
const WEB_FETCH_MAX_BYTES = 100_000;
const WEB_FETCH_TIMEOUT_MS = 15_000;
const WEB_FETCH_MAX_REDIRECTS = 5;

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

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    (((parts[0] ?? 0) << 24) >>> 0) +
    ((parts[1] ?? 0) << 16) +
    ((parts[2] ?? 0) << 8) +
    (parts[3] ?? 0)
  ) >>> 0;
}

function ipv4InCidr(address: string, base: string, bits: number): boolean {
  const ip = ipv4ToInt(address);
  const baseIp = ipv4ToInt(base);
  if (ip == null || baseIp == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (baseIp & mask);
}

function isPrivateOrReservedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => ipv4InCidr(address, String(base), Number(bits)));
  }

  if (family !== 6) return true;

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isPrivateOrReservedIp(mapped);
  }
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("0:0:0:0:0:0:0:") ||
    normalized.startsWith("2001:db8:")
  ) {
    return true;
  }

  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  if (!Number.isFinite(first)) return true;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

function hostnameForChecks(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function assertHttpUrlShape(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }
  if (!url.hostname) {
    throw new Error("URL must include a hostname");
  }
  const hostname = hostnameForChecks(url.hostname);
  if (isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new Error("Requests to private, loopback, or reserved IP addresses are not allowed");
  }
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  assertHttpUrlShape(url);
  const hostname = hostnameForChecks(url.hostname);

  if (isIP(hostname)) {
    return;
  }

  const results = await lookup(hostname, { all: true, verbatim: true });
  if (results.length === 0) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  const blocked = results.find((result) => isPrivateOrReservedIp(result.address));
  if (blocked) {
    throw new Error(
      `Hostname resolves to a private, loopback, or reserved IP address: ${blocked.address}`,
    );
  }
}

async function readResponseBody(res: Response, maxBytes: number): Promise<{
  body: string;
  truncated: boolean;
}> {
  if (!res.body) return { body: "", truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }

    chunks.push(value);
    total += value.byteLength;
  }

  if (!truncated) {
    const next = await reader.read();
    truncated = !next.done;
  }
  if (truncated) {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    body: new TextDecoder().decode(merged),
    truncated,
  };
}

async function fetchPublicUrl(
  initialUrl: URL,
  method: "GET" | "POST",
): Promise<{ url: string; response: Response }> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= WEB_FETCH_MAX_REDIRECTS; redirects++) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { url: current.toString(), response };
    }

    const location = response.headers.get("location");
    if (!location) return { url: current.toString(), response };
    current = new URL(location, current);
    method = "GET";
  }

  throw new Error(`Too many redirects (>${WEB_FETCH_MAX_REDIRECTS})`);
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

const MAX_VIEW_LINES = 160; // max lines returned by the view tool per call

/**
 * Build the complete set of built-in tools available to the agent.
 *
 * @param deps - Shared dependencies including approval state, prompt function, and file change recorder.
 * @returns A Vercel AI SDK `ToolSet` containing view, bash, edit, create, grep, and web_fetch.
 */
export function buildTools(deps: ToolDeps): ToolSet {
  const { approvals, prompt, recorder, viewedFiles, editedFiles } = deps;

  return {
    view: tool({
      description: "Read file lines. Max 160 lines; avoid repeated reads.",
      inputSchema: z.object({
        path: z.string(),
        startLine: z.number().int().min(1).optional().describe("1-based start"),
        endLine: z.number().int().min(1).optional().describe("1-based end"),
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
        const MIN_VIEW_LINES = 80;
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
      description: "Run shell commands for tests/builds/computation; do not use for file reads or search.",
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
        oldString: z.string().describe("Must match once"),
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
      description: "Search file content, or list files with filenamesOnly:true.",
      inputSchema: z.object({
        pattern: z.string().describe("Search pattern or filename glob"),
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
      description: "Fetch public HTTP/HTTPS URL text.",
      inputSchema: z.object({
        url: z.url(),
        method: z.enum(["GET", "POST"]).optional(),
      }),
      execute: async ({ url, method }) => {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url);
          assertHttpUrlShape(parsedUrl);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        const decision = await requestApproval(approvals, prompt, {
          toolName: "web_fetch",
          summary: `Fetch ${method ?? "GET"} ${url}`,
        });
        if (decision === "deny")
          return { denied: true, message: "User denied fetch" };
        try {
          const { url: finalUrl, response: res } = await fetchPublicUrl(
            parsedUrl,
            method ?? "GET",
          );
          const contentType = res.headers.get("content-type") ?? "";
          const read = await readResponseBody(res, WEB_FETCH_MAX_BYTES);
          let body = read.body;
          if (contentType.toLowerCase().includes("html")) {
            body = body
              .replaceAll(/<script[\s\S]*?<\/script>/gi, "")
              .replaceAll(/<style[\s\S]*?<\/style>/gi, "")
              .replaceAll(/<[^>]+>/g, " ")
              .replaceAll(/\s+/g, " ")
              .trim();
          }
          return {
            url: finalUrl,
            status: res.status,
            contentType,
            body: truncate(body),
            ...(read.truncated
              ? { note: `Response body truncated at ${WEB_FETCH_MAX_BYTES.toLocaleString()} bytes` }
              : undefined),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  } satisfies ToolSet;
}
