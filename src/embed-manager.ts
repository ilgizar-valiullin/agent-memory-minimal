/**
 * EmbedManager: thin watcher in the MCP process.
 * - No static import of transformers (keeps baseline RSS ~30-50MB).
 * - fork()es embed-worker.js on demand, coalesces concurrent loads.
 * - Kills worker after EMBED_IDLE_TIMEOUT_MS of no requests.
 * - On worker failure: throws -> caller falls back to FTS-only with vectorDegraded:true.
 */
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DIR, EMBED_IDLE_TIMEOUT_MS } from "./config.js";

type Pending = {
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
};

export type EmbedPrefix = "query" | "passage";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Machine-wide mutex so parallel MCP instances (one watcher per OpenCode
 * window) never run embedding workers concurrently. Peak worker memory
 * stays ~1 worker instead of N. The lock is a single file created with
 * O_EXCL (atomic); stale locks (dead pid or older than 60s) are broken
 * by waiters. A directory+pid two-step proved racy — do not split this.
 *
 * Contention awareness: waiters leave a marker in embed.lock.w/. If the
 * holder sees a fresh marker when releasing, another instance waited —
 * so it kills its worker immediately instead of leaving it warm for TTL.
 * Single-instance bursts keep warm reuse (fast); contended bursts converge
 * back to one live worker. Stale markers (>60s or dead pid) are ignored.
 */
/** Internal hook for tests: proves mutual exclusion deterministically. */
export { acquireEmbedSlot as __test_acquireEmbedSlot };
async function acquireEmbedSlot(): Promise<{ release: () => boolean }> {
  const lock = path.join(APP_DIR, "embed.lock");
  const waitDir = path.join(APP_DIR, "embed.lock.w");
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
  const stamp = `${process.pid}:${Date.now()}`;
  const marker = path.join(waitDir, String(process.pid));
  const slotTimeout = Number(process.env.AGENT_MEMORY_SLOT_TIMEOUT_MS || 30_000);
  const freshWaiters = (): boolean => {
    let found = false;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(waitDir);
    } catch {
      return false;
    }
    for (const e of entries) {
      const p = path.join(waitDir, e);
      try {
        const pid = Number(e);
        try {
          process.kill(pid, 0);
        } catch {
          fs.rmSync(p, { force: true });
          continue; // dead waiter
        }
        if (Date.now() - fs.statSync(p).mtimeMs > 60_000) {
          fs.rmSync(p, { force: true });
          continue; // stale waiter
        }
        if (e !== String(process.pid)) found = true;
      } catch {
        /* raced — ignore */
      }
    }
    return found;
  };
  try {
    fs.mkdirSync(waitDir, { recursive: true });
    fs.writeFileSync(marker, stamp);
  } catch {
    /* ignore — marker is best-effort */
  }
  const unmark = () => {
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* ignore */
    }
  };
  const deadline = Date.now() + slotTimeout;
  for (;;) {
    try {
      fs.writeFileSync(lock, stamp, { flag: "wx" });
      unmark();
      let released = false;
      return {
        release: () => {
          if (released) return false;
          released = true;
          const contended = freshWaiters();
          try {
            if (fs.readFileSync(lock, "utf8") === stamp) fs.rmSync(lock, { force: true });
          } catch {
            /* ignore — someone else broke/retook it */
          }
          return contended;
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") {
        unmark();
        throw e;
      }
      let stale = false;
      try {
        const cur = fs.readFileSync(lock, "utf8");
        const pid = Number(cur.split(":")[0]);
        try {
          process.kill(pid, 0);
        } catch {
          stale = true; // holder dead
        }
        if (!stale) {
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          if (age > 60_000) stale = true;
        }
      } catch {
        stale = true; // lock vanished mid-check — retry as fresh
      }
      if (stale) {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() > deadline) {
        unmark();
        throw new Error(
          "embed slot wait timeout: another instance holds the embedding worker. Retry once — slots free up in seconds (TTL 5s)."
        );
      }
      await sleep(50 + Math.floor(Math.random() * 50));
    }
  }
}

export class EmbedManager {
  private worker: ChildProcess | null = null;
  private loadPromise: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;
  private lastUsed = 0;

  private workerPath(): string {
    // dist/embed-worker.js in prod, src fallback via tsx not needed (always built).
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, "embed-worker.js");
  }

  private ensureWorker(): Promise<void> {
    if (this.worker && this.worker.connected) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Reset so the next embed() retries the spawn instead of
        // reusing this rejected promise forever.
        this.loadPromise = null;
        reject(new Error("embed worker spawn timeout: worker did not signal ready in 120s"));
      }, 120_000);
    let child: ChildProcess;
    try {
      // silent:true keeps the child's stdout/stderr off the MCP transport
      // pipe: any stray print would corrupt the JSON-RPC stream.
      // Cap the V8 heap: model weights live in native memory, the JS side
      // needs little. OOM here fails loudly and degrades to FTS-only.
      child = fork(this.workerPath(), [], {
        silent: true,
        execArgv: ["--max-old-space-size=512"],
      });
        child.stderr?.on("data", (d: Buffer) => {
          process.stderr.write(`[embed-worker] ${d.toString().slice(0, 500)}`);
        });
      } catch (e) {
        clearTimeout(timeout);
        this.loadPromise = null;
        reject(e as Error);
        return;
      }
      const onReady = (msg: unknown) => {
        if (msg && typeof msg === "object" && "ready" in (msg as object)) {
          clearTimeout(timeout);
          child.off("message", onReady as never);
          child.on("message", (m: unknown) => this.onMessage(m));
          child.once("exit", () => this.onExit());
          this.worker = child;
          this.loadPromise = null;
          resolve();
        }
      };
      child.on("message", onReady as never);
      child.once("error", (e) => {
        clearTimeout(timeout);
        this.loadPromise = null;
        reject(e);
      });
      child.once("exit", (code) => {
        if (!this.worker) {
          clearTimeout(timeout);
          this.loadPromise = null;
          reject(new Error(`embed worker exited early code=${code}`));
        }
      });
    });
    return this.loadPromise;
  }

  private onMessage(msg: unknown): void {
    const m = msg as { id?: number; ok?: boolean; vectors?: number[][]; error?: string };
    if (typeof m?.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) p.resolve(m.vectors ?? []);
    else p.reject(new Error(m.error || "embed worker error"));
  }

  private onExit(): void {
    for (const [, p] of this.pending) p.reject(new Error("embed worker exited"));
    this.pending.clear();
    this.worker = null;
  }

  private touch(): void {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.killWorker(), EMBED_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  killWorker(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const w = this.worker;
    this.worker = null;
    try {
      w?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  async embed(texts: string[], prefix: EmbedPrefix = "query"): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Machine-wide slot: only one embedding worker at a time, so N parallel
    // watchers peak at ~1 worker instead of N. Held for the whole operation
    // (spawn + inference), released right after.
    const slot = await acquireEmbedSlot();
    try {
      return await this.embedLocked(texts, prefix);
    } finally {
      const contended = slot.release();
      // Idle policy: worker's useful load is seconds per day, so by default
      // (IDLE_TIMEOUT 0) it dies immediately after use — zero idle memory.
      // With IDLE_TIMEOUT > 0, uncontended bursts keep warm reuse; a waiter
      // always forces an immediate kill to converge back to one worker.
      if (EMBED_IDLE_TIMEOUT_MS <= 0 || contended) this.killWorker();
      else this.touch();
    }
  }

  private async embedLocked(texts: string[], prefix: EmbedPrefix): Promise<number[][]> {
    await this.ensureWorker();
    const w = this.worker;
    if (!w || !w.connected) throw new Error("embed worker not connected");
    const id = ++this.seq;
    const res = new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("embed request timeout"));
      }, 60_000);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
    try {
      w.send({ id, texts, prefix });
    } catch (e) {
      this.pending.delete(id);
      this.worker = null;
      throw new Error(
        `embed worker channel closed before send: ${e instanceof Error ? e.message : String(e)}. Retry once — a fresh worker will be spawned.`
      );
    }
    try {
      return await res;
    } finally {
      this.touch();
    }
  }

  async embedOne(text: string, prefix: EmbedPrefix = "query"): Promise<number[]> {
    const [v] = await this.embed([text], prefix);
    if (!v) throw new Error("empty embedding");
    return v;
  }

  dispose(): void {
    this.killWorker();
  }
}
