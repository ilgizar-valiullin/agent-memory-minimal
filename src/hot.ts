#!/usr/bin/env node
/**
 * Hot backend: spawned by watcher.js on the first tools/call, killed when no
 * calls are in flight. Holds the DB, tools and embedding manager (worker
 * stays a separate grandchild process as before). Speaks internal line-JSON
 * RPC, NOT MCP — the watcher owns the MCP surface. No MCP SDK dependency.
 *
 * Parent -> hot: {"id":N,"tool":"memory_search","args":{...}}
 * Hot -> parent: {"id":N,"ok":true,"result":{...}} | {"id":N,"ok":false,"error":"..."}
 * Ready handshake: hot prints {"ready":true} after DB open.
 */
import { DB_PATH, ensureAppDir } from "./config.js";
import { openDb } from "./db.js";
import { EmbedManager } from "./embed-manager.js";
import { createHandlers } from "./tools.js";

type Handler = (args: never) => Promise<unknown>;

let handlers: Record<string, Handler> | null = null;

function fail(line: string, id: number | null, message: string): void {
  void line;
  process.stdout.write(JSON.stringify({ id, ok: false, error: message }) + "\n");
}

try {
  ensureAppDir();
  if (!DB_PATH || !DB_PATH.trim()) {
    throw new Error("database path is empty. Set AGENT_MEMORY_DB to a valid file path.");
  }
  const db = openDb(DB_PATH);
  const embeds = new EmbedManager();
  handlers = createHandlers(db, embeds) as Record<string, Handler>;
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
} catch (e) {
  process.stderr.write(
    `hot backend startup failed: ${e instanceof Error ? e.message : String(e)}\n`
  );
  process.exit(1);
}

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  let idx: number;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    void dispatch(line);
  }
});

async function dispatch(line: string): Promise<void> {
  let msg: { id?: unknown; tool?: unknown; args?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    fail(line, null, "hot backend: malformed JSON (expected {id, tool, args})");
    return;
  }
  if (typeof msg.id !== "number" || typeof msg.tool !== "string") {
    fail(line, typeof msg.id === "number" ? msg.id : -1, "hot backend: malformed request");
    return;
  }
  const fn = handlers![msg.tool];
  if (!fn) {
    fail(line, msg.id, `unknown tool: ${msg.tool}`);
    return;
  }
  try {
    const result = await fn((msg.args ?? {}) as never);
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result }) + "\n");
  } catch (e) {
    fail(line, msg.id, e instanceof Error ? e.message : String(e));
  }
}

process.stdin.on("end", () => process.exit(0));
