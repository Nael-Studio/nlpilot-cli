import kleur from "kleur";

export type ApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface ApprovalState {
  alwaysAllow: Set<string>;
  autopilot: boolean;
  /** Tools always allowed (no prompt). */
  allowList: Set<string>;
  /** Tools that are denied outright. */
  denyList: Set<string>;
  /** When true, no interactive prompt is available; deny anything not pre-allowed. */
  nonInteractive: boolean;
  /** Suppress human-readable approval prompt logs; useful for JSON transports. */
  silentPrompts: boolean;
  /** Mutex to serialise concurrent approval prompts. */
  _promptLock: Promise<void>;
}

export interface CreateApprovalOptions {
  autopilot?: boolean;
  allow?: string[];
  deny?: string[];
  nonInteractive?: boolean;
  silentPrompts?: boolean;
}

export function createApprovalState(
  options: CreateApprovalOptions = {},
): ApprovalState {
  return {
    alwaysAllow: new Set<string>(),
    autopilot: options.autopilot ?? false,
    allowList: new Set(options.allow ?? []),
    denyList: new Set(options.deny ?? []),
    nonInteractive: options.nonInteractive ?? false,
    silentPrompts: options.silentPrompts ?? false,
    _promptLock: Promise.resolve(),
  };
}

export interface ApprovalRequest {
  toolName: string;
  summary: string;
  details?: string;
}

export type PromptFn = (
  question: string,
  request?: ApprovalRequest,
) => Promise<string>;

export async function requestApproval(
  state: ApprovalState,
  prompt: PromptFn,
  req: ApprovalRequest,
): Promise<ApprovalDecision> {
  if (state.denyList.has(req.toolName)) return "deny";
  if (state.allowList.has(req.toolName)) return "allow-session";
  if (state.autopilot) return "allow-session";
  if (state.alwaysAllow.has(req.toolName)) return "allow-session";
  if (state.nonInteractive) return "deny";

  // Serialise prompts: wait for any in-progress approval to finish first,
  // then hold the lock while we ask the user.
  let releaseLock!: () => void;
  const prevLock = state._promptLock;
  state._promptLock = new Promise<void>((resolve) => { releaseLock = resolve; });

  try {
    await prevLock;

    // Re-check fast-path after waiting (user may have pressed [!] for a prior call).
    if (state.alwaysAllow.has(req.toolName)) return "allow-session";

    if (!state.silentPrompts) {
      console.log();
      console.log(kleur.yellow("⚠"), kleur.bold(`Tool request: ${req.toolName}`));
      console.log(`  ${req.summary}`);
      if (req.details) {
        for (const line of req.details.split("\n")) {
          console.log(kleur.dim(`  │ ${line}`));
        }
      }
    }

    const answer = (
      await prompt(
        kleur.cyan("Allow? ") +
          kleur.dim("[y]es / [!] always this session / [n]o ") +
          "› ",
        req,
      )
    )
      .trim()
      .toLowerCase();

    if (answer === "!" || answer === "always" || answer === "a") {
      state.alwaysAllow.add(req.toolName);
      return "allow-session";
    }
    if (answer === "y" || answer === "yes" || answer === "") {
      return "allow-once";
    }
    return "deny";
  } finally {
    releaseLock();
  }
}
