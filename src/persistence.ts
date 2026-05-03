import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ModelMessage } from "ai";

const SESSIONS_DIR = join(homedir(), ".nlpilot", "sessions");

export interface PersistedSession {
  id: string;
  name?: string;
  cwd: string;
  modelName: string;
  provider: string;
  updatedAt: number;
  createdAt: number;
  messages: ModelMessage[];
  cumulativeInputTokens?: number; // Optional for backwards compatibility
  cumulativeOutputTokens?: number; // Optional for backwards compatibility
}

function cwdHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

function dirForCwd(cwd: string): string {
  return join(SESSIONS_DIR, cwdHash(cwd));
}

function fileForId(cwd: string, id: string): string {
  return join(dirForCwd(cwd), `${id}.json`);
}

/**
 * Persist a session to disk under `~/.nlpilot/sessions/<cwd-hash>/`.
 *
 * @param session - The session to save.
 * @returns The full path to the written JSON file.
 */
export async function saveSession(session: PersistedSession): Promise<string> {
  const dir = dirForCwd(session.cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = fileForId(session.cwd, session.id);
  await writeFile(path, JSON.stringify(session, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * List all persisted sessions for the given working directory, sorted by most recent first.
 *
 * @param cwd - Working directory to look up sessions for. Defaults to `process.cwd()`.
 * @returns An array of parsed session objects. Corrupt files are silently skipped.
 */
export async function listSessions(
  cwd: string = process.cwd(),
): Promise<PersistedSession[]> {
  const dir = dirForCwd(cwd);
  const files = await safeReaddir(dir);
  const out: PersistedSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".display.json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as PersistedSession);
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * Load a single persisted session by its ID.
 *
 * @param id - The session identifier.
 * @param cwd - Working directory the session belongs to. Defaults to `process.cwd()`.
 * @returns The parsed session, or `null` if the file does not exist.
 */
export async function loadSession(
  id: string,
  cwd: string = process.cwd(),
): Promise<PersistedSession | null> {
  try {
    return JSON.parse(await readFile(fileForId(cwd, id), "utf8")) as PersistedSession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Find a session by its human-readable name.
 *
 * @param name - The session name to search for.
 * @param cwd - Working directory to search within. Defaults to `process.cwd()`.
 * @returns The first matching session, or `null` if none found.
 */
export async function loadSessionByName(
  name: string,
  cwd: string = process.cwd(),
): Promise<PersistedSession | null> {
  const sessions = await listSessions(cwd);
  return sessions.find((s) => s.name === name) ?? null;
}

/**
 * Load the most recently updated session for the given working directory.
 *
 * @param cwd - Working directory to search within. Defaults to `process.cwd()`.
 * @returns The most recent session, or `null` if no sessions exist.
 */
export async function loadMostRecentSession(
  cwd: string = process.cwd(),
): Promise<PersistedSession | null> {
  const sessions = await listSessions(cwd);
  return sessions[0] ?? null;
}

/**
 * Delete a persisted session by ID.
 *
 * @param id - The session identifier.
 * @param cwd - Working directory the session belongs to. Defaults to `process.cwd()`.
 * @returns `true` if the file was deleted, `false` if it did not exist.
 */
export async function deleteSession(
  id: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  try {
    await unlink(fileForId(cwd, id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Rename (set the display name of) an existing session.
 *
 * @param id - The session identifier.
 * @param name - The new human-readable name.
 * @param cwd - Working directory the session belongs to. Defaults to `process.cwd()`.
 * @returns `true` if the session was found and updated, `false` otherwise.
 */
export async function renameSession(
  id: string,
  name: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  const s = await loadSession(id, cwd);
  if (!s) return false;
  s.name = name;
  s.updatedAt = Date.now();
  await saveSession(s);
  return true;
}

/**
 * Generate a new unique session identifier.
 *
 * @returns A base-36 timestamp + random suffix string.
 */
export function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
