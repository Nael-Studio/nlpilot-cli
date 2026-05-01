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

export async function listSessions(
  cwd: string = process.cwd(),
): Promise<PersistedSession[]> {
  const dir = dirForCwd(cwd);
  const files = await safeReaddir(dir);
  const out: PersistedSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as PersistedSession);
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

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

export async function loadSessionByName(
  name: string,
  cwd: string = process.cwd(),
): Promise<PersistedSession | null> {
  const sessions = await listSessions(cwd);
  return sessions.find((s) => s.name === name) ?? null;
}

export async function loadMostRecentSession(
  cwd: string = process.cwd(),
): Promise<PersistedSession | null> {
  const sessions = await listSessions(cwd);
  return sessions[0] ?? null;
}

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

export function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
