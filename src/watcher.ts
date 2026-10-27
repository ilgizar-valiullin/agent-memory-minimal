#!/usr/bin/env node
/**
 * Cold watcher: waits for commands, runs hot mode on demand. Zero dependencies
 * (node builtins only) so idle RSS stays near bare-node levels across many
 * parallel OpenCode instances. Speed loss is accepted by design.
 *
 * - tools/list and initialize/ping are answered directly, nothing is spawned.
 * - First tools/call spawns hot.js (full backend: SQLite + embeddings worker),
 *   proxies the call over internal line-JSON RPC, then kills hot when no
 *   calls are in flight (refcount drain; HOT_IDLE_TIMEOUT_MS > 0 keeps it
 *   warm instead). Peak per instance: watcher + hot only while working.
 * - Speaks MCP over stdio, newline-delimited JSON and legacy Content-Length
 *   framing both accepted.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toolSchemas } from "./schema.js";

const VERSION = "0.2.0";
const KNOWN_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST_PROTOCOL = "2025-11-25";
const HOT_IDLE_TIMEOUT_MS = Number(process.env.AGENT_MEMORY_HOT_IDLE_TIMEOUT_MS || 0);
const CALL_TIMEOUT_MS = 150_000;

type HotCall = { id: number; tool: string; args: unknown };
type HotReply = { id: number; ok: boolean; result?: unknown; error?: string };
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

let hot: ChildProcess | null = null;
let hotSpawn: Promise<void> | null = null;
let hotBuf = "";
let hotSeq = 0;
const hotPending = new Map<number, Pending>();
let hotActive = 0;
let hotIdleTimer: NodeJS.Timeout | null = null;

function hotPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "hot.js");
}

function hotKill(): void {
  if (hotIdleTimer) {
    clearTimeout(hotIdleTimer);
    hotIdleTimer = null;
  }
  const h = hot;
  hot = null;
  for (const [, p] of hotPending) {
    clearTimeout(p.timer);
    p.reject(new Error("hot backend exited before replying; retry once — it restarts on demand"));
  }
  hotPending.clear();
  try {
    h?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
}

function onHotLine(line: string): void {
  let msg: HotReply;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg?.id !== "number") return;
  const p = hotPending.get(msg.id);
  if (!p) return;
  hotPending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || "hot backend error"));
}

function hotAlive(h: ChildProcess | null): h is ChildProcess {
  // NOTE: spawn()ed children never have .connected (no IPC channel) —
  // liveness is exitCode/signalCode only.
  return !!h && h.exitCode === null && h.signalCode === null;
}

function ensureHot(): Promise<void> {
  if (hotAlive(hot)) {
    return Promise.resolve();
  }
  if (hotSpawn) return hotSpawn;
  hotSpawn = new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [hotPath()], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      hotSpawn = null;
      reject(
        new Error(
          `hot backend failed to spawn: ${e instanceof Error ? e.message : String(e)} (run npm run build?)`
        )
      );
      return;
    }
    const fail = (why: string) => {
      hotSpawn = null;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      reject(new Error(`hot backend failed to start: ${why} (run npm run build?)`));
    };
    child.on("error", (e) => {
      if (!hot) fail(e.message);
    });
    child.on("exit", (code, signal) => {
      const was = hot === child;
      if (was) hotKill();
      if (hotSpawn) {
        hotSpawn = null;
        fail(`exited code=${code} signal=${signal}`);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[hot] ${d.toString().slice(0, 500)}`);
    });
    // Ready handshake: hot prints {"ready":true} after DB open.
    const onData = (chunk: Buffer) => {
      hotBuf += chunk.toString();
      let idx: number;
      while ((idx = hotBuf.indexOf("\n")) !== -1) {
        const line = hotBuf.slice(0, idx).trim();
        hotBuf = hotBuf.slice(idx + 1);
        if (!line) continue;
        if (!hot) {
          try {
            const m = JSON.parse(line) as { ready?: boolean };
            if (m && m.ready === true) {
              hot = child;
              child.stdout?.off("data", onData);
              child.stdout?.on("data", (c: Buffer) => {
                hotBuf += c.toString();
                let i: number;
                while ((i = hotBuf.indexOf("\n")) !== -1) {
                  const l = hotBuf.slice(0, i).trim();
                  hotBuf = hotBuf.slice(i + 1);
                  if (l) onHotLine(l);
                }
              });
              hotSpawn = null;
              resolve();
              return;
            }
          } catch {
            /* not JSON yet — keep buffering */
          }
        } else {
          onHotLine(line);
        }
      }
    };
    child.stdout?.on("data", onData);
    setTimeout(() => {
      if (hotSpawn) {
        hotSpawn = null;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        reject(new Error("hot backend start timeout (30s)"));
      }
    }, 30_000).unref?.();
  });
  return hotSpawn;
}

async function callHot(tool: string, args: unknown): Promise<unknown> {
  await ensureHot();
  const h = hot;
  if (!hotAlive(h) || !h.stdin) throw new Error("hot backend not connected");
  const id = ++hotSeq;
  hotActive++;
  if (hotIdleTimer) {
    clearTimeout(hotIdleTimer);
    hotIdleTimer = null;
  }
  try {
    const res = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        hotPending.delete(id);
        try {
          h.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        reject(new Error(`hot backend call timeout (${CALL_TIMEOUT_MS}ms): ${tool}`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      hotPending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
      try {
        h.stdin!.write(JSON.stringify({ id, tool, args } satisfies HotCall) + "\n");
      } catch (e) {
        hotPending.delete(id);
        clearTimeout(timer);
        reject(
          new Error(`hot backend channel closed: ${e instanceof Error ? e.message : String(e)}`)
        );
      }
    });
    return res;
  } finally {
    hotActive--;
    if (hotActive <= 0) {
      hotActive = 0;
      if (HOT_IDLE_TIMEOUT_MS <= 0) hotKill();
      else {
        if (hotIdleTimer) clearTimeout(hotIdleTimer);
        hotIdleTimer = setTimeout(() => hotKill(), HOT_IDLE_TIMEOUT_MS);
        hotIdleTimer.unref?.();
      }
    }
  }
}

// ---- Minimal MCP over stdio (newline-delimited and Content-Length) ----

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function mcpResult(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function mcpError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg: {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}): Promise<void> {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  if (typeof method !== "string") {
    if (!isNotification) mcpError(id ?? null, -32600, "Invalid Request: missing method");
    return;
  }
  switch (method) {
    case "initialize": {
      const reqVer =
        params && typeof params === "object"
          ? (params as Record<string, unknown>).protocolVersion
          : undefined;
      const version =
        typeof reqVer === "string" && KNOWN_PROTOCOLS.includes(reqVer) ? reqVer : LATEST_PROTOCOL;
      mcpResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-memory-minimal", version: VERSION },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications: no reply
    case "ping":
      mcpResult(id, {});
      return;
    case "tools/list":
      mcpResult(id, { tools: toolSchemas() });
      return;
    case "tools/call": {
      const p = (params ?? {}) as Record<string, unknown>;
      if (typeof p.name !== "string") {
        mcpError(id, -32602, "Invalid params: tools/call requires {name: string, arguments?: object}");
        return;
      }
      const args = p.arguments === undefined ? {} : p.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        mcpError(id, -32602, "Invalid params: arguments must be an object");
        return;
      }
      try {
        const result = await callHot(p.name, args);
        mcpResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        // Tool-level failure: MCP result with isError (same contract as before).
        mcpResult(id, {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
      return;
    }
    default:
      if (!isNotification) mcpError(id, -32601, `Method not found: ${method}`);
  }
}

let inBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  for (;;) {
    // Legacy Content-Length framing?
    if (inBuf.slice(0, 15).toString().startsWith("Content-Length")) {
      const h = inBuf.indexOf("\r\n\r\n");
      if (h === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(inBuf.slice(0, h).toString());
      const len = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(len)) {
        inBuf = inBuf.slice(h + 4);
        continue;
      }
      if (inBuf.length < h + 4 + len) return;
      const body = inBuf.slice(h + 4, h + 4 + len).toString();
      inBuf = inBuf.slice(h + 4 + len);
      dispatchLine(body);
    } else {
      const nl = inBuf.indexOf("\n");
      if (nl === -1) return;
      const line = inBuf.slice(0, nl).toString().trim();
      inBuf = inBuf.slice(nl + 1);
      if (!line) continue;
      dispatchLine(line);
    }
  }
});

function dispatchLine(line: string): void {
  let msg: { id?: unknown; method?: unknown; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    mcpError(null, -32700, "Parse error: expected a JSON-RPC object per line");
    return;
  }
  void handleMessage(msg);
}

function shutdown(): void {
  hotKill();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
