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

/**
 * Load lifecycle hooks from `.nlpilot/hooks/hooks.json` or `config.json`.
 *
 * @param cwd - Project root to search for the `.nlpilot/hooks/` directory. Defaults to `process.cwd()`.
 * @returns A hooks configuration object, or an empty config if no hooks are defined.
 */
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

function hookMatches(hook: HookSpec, event: HookEvent, ctx: HookContext): boolean {
  if (hook.event !== event) return false;
  if (!hook.match || !ctx.toolName) return true;

  try {
    return new RegExp(hook.match).test(ctx.toolName);
  } catch {
    return false;
  }
}

/**
 * Execute all hooks matching the given event and optional tool-name filter.
 *
 * Hooks run sequentially. Errors are silently swallowed so hooks can never crash the REPL.
 *
 * @param cfg - The loaded hooks configuration.
 * @param event - The lifecycle event to trigger.
 * @param ctx - Contextual data passed to each hook (tool name, I/O, session ID, etc.).
 */
export async function runHooks(
  cfg: HooksConfig,
  event: HookEvent,
  ctx: HookContext,
): Promise<void> {
  const matching = cfg.hooks.filter((h) => hookMatches(h, event, ctx));
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
