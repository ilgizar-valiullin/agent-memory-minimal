import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function appDataDir(): string {
  if (process.env.AGENT_MEMORY_DIR) return process.env.AGENT_MEMORY_DIR;
  const plat = process.platform;
  if (plat === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "agent-memory-minimal");
  }
  if (plat === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "agent-memory-minimal");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "agent-memory-minimal");
}

export const APP_DIR = appDataDir();
export const DB_PATH =
  process.env.AGENT_MEMORY_DB || path.join(APP_DIR, "memory.sqlite");
export const MODEL_CACHE_DIR =
  process.env.AGENT_MEMORY_MODEL_CACHE || path.join(APP_DIR, "models");
export const EMBED_MODEL =
  process.env.AGENT_MEMORY_MODEL || "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;
// 0 = kill the worker immediately after each use (no warm idle at all).
// The worker's useful load is seconds per day; warm reuse rarely hits
// because agent round-trips outlast any TTL. Set >0 to keep warm reuse
// for back-to-back bursts (e.g. 5000).
export const EMBED_IDLE_TIMEOUT_MS = Number(
  process.env.AGENT_MEMORY_IDLE_TIMEOUT_MS || 0
);
export const EMBED_BATCH_SIZE = Number(process.env.AGENT_MEMORY_BATCH_SIZE || 32);

export function ensureAppDir(): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
}
