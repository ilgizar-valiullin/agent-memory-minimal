import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EMBED_DIM } from "./config.js";

export type Db = InstanceType<typeof Database>;

export interface MemoryRow {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ScoredMemory extends MemoryRow {
  score: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isBusyError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("SQLITE_BUSY") ||
    msg.includes("database is locked") ||
    msg.includes("database table is locked")
  );
}

export function openDb(dbPath: string): Db {
  if (!dbPath || !dbPath.trim()) {
    throw new Error("openDb: database path is empty.");
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: Db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    throw new Error(
      `openDb: cannot open database at ${dbPath} (directory must exist and be writable): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  try {
    sqliteVec.load(db);
  } catch (e) {
    throw new Error(
      `openDb: failed to load sqlite-vec extension (check sqlite-vec/better-sqlite3 versions match your Node arch): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("wal_autocheckpoint = 1000");
  initSchema(db);
  return db;
}

export function initSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories(
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(createdAt DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED, title, content, tags
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${EMBED_DIM}]
    );
  `);
}

function tagsJson(tags: string[]): string {
  return JSON.stringify(tags);
}

function rowToMemory(r: {
  id: string;
  title: string;
  content: string;
  tags: string;
  createdAt: number;
  updatedAt: number;
}): MemoryRow {
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags);
  } catch {
    tags = [];
  }
  return { ...r, tags };
}

function tagsWhereClause(
  tags: string[] | undefined,
  prefix: string
): { sql: string; params: Record<string, string> } {
  if (!tags || tags.length === 0) return { sql: "", params: {} };
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  tags.forEach((t, i) => {
    const k = `${prefix}tag${i}`;
    clauses.push(`EXISTS (SELECT 1 FROM json_each(m.tags) j WHERE j.value = @${k})`);
    params[k] = t;
  });
  return { sql: ` AND ${clauses.join(" AND ")}`, params };
}

/** In-process write queue: serializes BEGIN IMMEDIATE within one MCP process. */
export function createWriter(db: Db) {
  let tail: Promise<void> = Promise.resolve();

  function run<T>(fn: () => T): Promise<T> {
    const next = tail.then(
      () =>
        new Promise<T>((resolve, reject) => {
          try {
            resolve(fn());
          } catch (e) {
            reject(e);
          }
        })
    );
    tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async function withRetry<T>(fn: () => T, attempts = 5): Promise<T> {
    let delay = 20;
    for (let i = 0; i < attempts; i++) {
      try {
        return await run(fn);
      } catch (e) {
        if (!isBusyError(e) || i === attempts - 1) throw e;
        await sleep(delay + Math.floor(Math.random() * 20));
        delay = Math.min(delay * 3, 800);
      }
    }
    throw new Error("unreachable");
  }

  return {
    insertMemory(input: {
      title: string;
      content: string;
      tags: string[];
      embedding?: number[] | Float32Array;
    }): Promise<MemoryRow> {
      return withRetry(() => {
        const id = randomUUID();
        const now = Date.now();
        const tags = tagsJson(input.tags ?? []);
        db.exec(`BEGIN IMMEDIATE;`);
        try {
          db.prepare(
            `INSERT INTO memories(id, title, content, tags, createdAt, updatedAt)
             VALUES(@id, @title, @content, @tags, @now, @now);`
          ).run({ id, title: input.title, content: input.content, tags, now });
          db.prepare(
            `INSERT INTO memories_fts(id, title, content, tags)
             VALUES(@id, @title, @content, @tags);`
          ).run({ id, title: input.title, content: input.content, tags });
          if (input.embedding && input.embedding.length === EMBED_DIM) {
            const vec = JSON.stringify(Array.from(input.embedding as ArrayLike<number>));
            db.prepare(`INSERT INTO vec_memories(id, embedding) VALUES(@id, @vec);`).run({
              id,
              vec,
            });
          }
          db.exec(`COMMIT;`);
        } catch (e) {
          try {
            db.exec(`ROLLBACK;`);
          } catch {
            /* ignore */
          }
          throw e;
        }
        return {
          id,
          title: input.title,
          content: input.content,
          tags: input.tags ?? [],
          createdAt: now,
          updatedAt: now,
        };
      });
    },
  };
}

export function ftsSearch(
  db: Db,
  query: string,
  limit: number,
  tags?: string[]
): ScoredMemory[] {
  const { sql, params } = tagsWhereClause(tags, "fts");
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.content, m.tags, m.createdAt, m.updatedAt, rank AS score
       FROM memories_fts f JOIN memories m ON m.id = f.id
       WHERE memories_fts MATCH @q${sql}
       ORDER BY rank LIMIT @limit;`
    )
    .all({ q: query, limit, ...params }) as unknown as Array<
    MemoryRow & { tags: string; score: number }
  >;
  return rows.map((r) => ({ ...rowToMemory(r), score: r.score }));
}

export function vecSearch(
  db: Db,
  vector: ArrayLike<number>,
  limit: number,
  tags?: string[]
): ScoredMemory[] {
  if (vector.length !== EMBED_DIM) return [];
  const vec = JSON.stringify(Array.from(vector));
  // Tag filter applied post-query (vec KNN + join) to keep SQL portable.
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.content, m.tags, m.createdAt, m.updatedAt, v.distance AS score
       FROM vec_memories v JOIN memories m ON m.id = v.id
       WHERE v.embedding MATCH @vec AND k = @limit
       ORDER BY v.distance LIMIT @limit;`
    )
    .all({ vec, limit }) as unknown as Array<
    MemoryRow & { tags: string; score: number }
  >;
  let out = rows.map((r) => ({ ...rowToMemory(r), score: r.score }));
  if (tags && tags.length > 0) {
    const set = new Set(tags);
    out = out.filter((m) => m.tags.some((t) => set.has(t)));
  }
  return out;
}

export function listMemories(
  db: Db,
  limit: number,
  offset: number,
  tags?: string[]
): { rows: MemoryRow[]; total: number } {
  const { sql, params } = tagsWhereClause(tags, "lst");
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM memories m WHERE 1=1${sql};`)
    .get(params) as unknown as { n: number };
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.content, m.tags, m.createdAt, m.updatedAt
       FROM memories m WHERE 1=1${sql}
       ORDER BY m.createdAt DESC LIMIT @limit OFFSET @offset;`
    )
    .all({ ...params, limit, offset }) as unknown as Array<
    MemoryRow & { tags: string }
  >;
  return { rows: rows.map(rowToMemory), total: totalRow.n };
}
