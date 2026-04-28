import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type HookEvent =
  | "preToolUse"
  | "postToolUse"
  | "sessionStart"
  | "agentStop";

export interface HookSpec {
  event: HookEvent;
  type: "command" | "http";
  command?: string;
  url?: string;
  match?: string; // tool name pattern (preToolUse/postToolUse)
}

export interface HooksConfig {
  hooks: HookSpec[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadHooks(cwd: string = process.cwd()): Promise<HooksConfig> {
  const dir = join(cwd, ".nlpilot", "hooks");
  if (!(await exists(dir))) return { hooks: [] };
  const candidates = ["hooks.json", "config.json"];
  for (const name of candidates) {
    const path = join(dir, name);
    if (await exists(path)) {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as HooksConfig;
        return { hooks: Array.isArray(parsed.hooks) ? parsed.hooks : [] };
      } catch {
        return { hooks: [] };
      }
    }
  }
  return { hooks: [] };
}

export interface HookContext {
  toolName?: string;
  input?: unknown;
  output?: unknown;
  sessionId?: string;
  cwd?: string;
}

export async function runHooks(
  cfg: HooksConfig,
  event: HookEvent,
  ctx: HookContext,
): Promise<void> {
  const matching = cfg.hooks.filter((h) => {
    if (h.event !== event) return false;
    if (h.match && ctx.toolName && !new RegExp(h.match).test(ctx.toolName)) {
      return false;
    }
    return true;
  });
  for (const hook of matching) {
    try {
      if (hook.type === "command" && hook.command) {
        await runCommandHook(hook.command, ctx);
      } else if (hook.type === "http" && hook.url) {
        await fetch(hook.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event, ...ctx }),
        }).catch(() => undefined);
      }
    } catch {
      /* never throw from hooks */
    }
  }
}

function runCommandHook(command: string, ctx: HookContext): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        NLPILOT_HOOK_TOOL: ctx.toolName ?? "",
        NLPILOT_HOOK_SESSION: ctx.sessionId ?? "",
        NLPILOT_HOOK_CWD: ctx.cwd ?? "",
      },
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
    child.stdin?.end(JSON.stringify(ctx));
  });
}
