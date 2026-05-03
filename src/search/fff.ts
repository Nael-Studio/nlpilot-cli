import type {
  FileFinder as FffFinder,
  GrepMatch,
  GrepMode,
  InitOptions,
  Result,
} from "@ff-labs/fff-node";

type FffModule = {
  FileFinder: {
    isAvailable(): boolean;
    create(options: InitOptions): Result<FffFinder>;
  };
};

export type FffSearchResult =
  | { ok: true; finder: FffFinder }
  | { ok: false; error: string };

type CachedFinder = {
  finder: FffFinder;
  ready: Promise<void>;
};

const moduleName = "@ff-labs/fff-node";
const finders = new Map<string, CachedFinder>();
let fffModule: Promise<FffModule | null> | undefined;
let unavailableReason: string | undefined;

async function loadFff(): Promise<FffModule | null> {
  if (!fffModule) {
    fffModule = import(moduleName)
      .then((mod) => mod as FffModule)
      .catch((err: unknown) => {
        unavailableReason = err instanceof Error ? err.message : String(err);
        return null;
      });
  }
  return fffModule;
}

export async function getFffFinder(cwd: string): Promise<FffSearchResult> {
  const cached = finders.get(cwd);
  if (cached) {
    await cached.ready;
    return { ok: true, finder: cached.finder };
  }

  const mod = await loadFff();
  if (!mod) {
    return { ok: false, error: unavailableReason ?? "FFF module is unavailable" };
  }

  try {
    if (!mod.FileFinder.isAvailable()) {
      return { ok: false, error: "FFF native library is unavailable" };
    }
    const created = mod.FileFinder.create({
      basePath: cwd,
      aiMode: true,
      disableWatch: false,
    });
    if (!created.ok) {
      return { ok: false, error: created.error };
    }

    const entry: CachedFinder = {
      finder: created.value,
      ready: created.value.waitForScan(3_000).then(() => undefined),
    };
    finders.set(cwd, entry);
    await entry.ready;
    return { ok: true, finder: entry.finder };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function makeFffGrepQuery(pattern: string, glob?: string): string {
  if (!glob || glob === "**/*") return pattern;
  return `${glob} ${pattern}`;
}

export function mapFffMode(regex?: boolean): GrepMode {
  return regex ? "regex" : "plain";
}

export function mapFffMatch(match: GrepMatch, contextLines: number): {
  file: string;
  line: number;
  text: string;
  context?: string[];
} {
  const entry: {
    file: string;
    line: number;
    text: string;
    context?: string[];
  } = {
    file: match.relativePath,
    line: match.lineNumber,
    text: match.lineContent.slice(0, 300),
  };

  if (contextLines > 0) {
    const before = match.contextBefore ?? [];
    const after = match.contextAfter ?? [];
    const startLine = match.lineNumber - before.length;
    entry.context = [
      ...before.map((line, index) => `${startLine + index}: ${line.slice(0, 300)}`),
      `${match.lineNumber}: ${match.lineContent.slice(0, 300)}`,
      ...after.map((line, index) => `${match.lineNumber + index + 1}: ${line.slice(0, 300)}`),
    ];
  }

  return entry;
}
