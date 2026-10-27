import type { Db } from "./db.js";
import {
  createWriter,
  ftsSearch,
  listMemories,
  vecSearch,
  type MemoryRow,
} from "./db.js";
import { EmbedManager } from "./embed-manager.js";

export interface WriteInput {
  title: string;
  content: string;
  tags?: string[];
}

export interface SearchInput {
  query: string;
  limit?: number;
  tags?: string[];
}

export interface ListInput {
  limit?: number;
  offset?: number;
  tags?: string[];
}

function RRfMerge(
  vec: { m: MemoryRow; score: number }[],
  fts: { m: MemoryRow; score: number }[],
  limit: number
) {
  const rank = new Map<string, { m: MemoryRow; s: number }>();
  const add = (m: MemoryRow, r: number, w: number) => {
    const prev = rank.get(m.id);
    const s = w / (60 + r);
    if (prev) {
      prev.s += s;
    } else {
      rank.set(m.id, { m, s });
    }
  };
  vec.forEach((v, i) => add(v.m, i, 2));
  fts.forEach((f, i) => add(f.m, i, 1));
  return [...rank.values()]
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.m);
}

function sanitizeQuery(q: string): string {
  // FTS5: strip quotes/colons that break MATCH syntax; keep words.
  return (
    q
      .replace(/["':()]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, "")}"`)
      .join(" OR ") || ""
  );
}

// ---- Input validation: every handler rejects malformed input with an
// actionable message instead of leaking TypeError/SQLite errors or
// silently returning wrong results. ----

const MAX_TITLE = 500;
const MAX_CONTENT = 20_000;
const MAX_QUERY = 1_000;
const MAX_TAGS = 30;
const MAX_TAG_LEN = 200;

function assertRecord(args: unknown, tool: string): asserts args is Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${tool}: arguments must be an object. Got: ${Array.isArray(args) ? "array" : String(args)}.`);
  }
}

function strField(args: Record<string, unknown>, tool: string, field: string, max: number): string {
  const v = args[field];
  if (typeof v !== "string") {
    throw new Error(`${tool}: '${field}' must be a string. Got: ${v === null ? "null" : typeof v}.`);
  }
  if (!v.trim()) {
    throw new Error(`${tool}: '${field}' must be non-empty.`);
  }
  if (v.length > max) {
    throw new Error(
      `${tool}: '${field}' is ${v.length} chars, max is ${max}. Split the fact into smaller notes.`
    );
  }
  return v;
}

function optStrField(args: Record<string, unknown>, tool: string, field: string, max: number): string | undefined {
  const v = args[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new Error(`${tool}: '${field}' must be a string. Got: ${v === null ? "null" : typeof v}.`);
  }
  if (!v.trim()) {
    throw new Error(`${tool}: '${field}' must be non-empty when provided.`);
  }
  if (v.length > max) {
    throw new Error(
      `${tool}: '${field}' is ${v.length} chars, max is ${max}. Narrow the query or split the note.`
    );
  }
  return v;
}

function tagsField(args: Record<string, unknown>, tool: string): string[] | undefined {
  const v = args.tags;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new Error(`${tool}: 'tags' must be an array of namespace:value strings. Got: ${typeof v}.`);
  }
  if (v.length > MAX_TAGS) {
    throw new Error(`${tool}: too many tags (${v.length}), max is ${MAX_TAGS}.`);
  }
  return v.map((t, i) => {
    if (typeof t !== "string" || !t.trim()) {
      throw new Error(`${tool}: tags[${i}] must be a non-empty string in namespace:value format.`);
    }
    if (t.length > MAX_TAG_LEN) {
      throw new Error(`${tool}: tags[${i}] is ${t.length} chars, max is ${MAX_TAG_LEN}.`);
    }
    if (!t.includes(":")) {
      throw new Error(
        `${tool}: tags[${i}] ${JSON.stringify(t)} has no namespace. Use namespace:value, e.g. 'project:myproj'.`
      );
    }
    return t;
  });
}

function numField(
  args: Record<string, unknown>,
  tool: string,
  field: string,
  def: number,
  min: number,
  max: number
): number {
  const v = args[field];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${tool}: '${field}' must be a finite number. Got: ${JSON.stringify(v)}.`);
  }
  return Math.min(Math.max(Math.floor(v), min), max);
}

export function createHandlers(db: Db, embeds: EmbedManager) {
  const writer = createWriter(db);

  return {
    async memory_write(args: WriteInput) {
      assertRecord(args, "memory_write");
      const title = strField(args, "memory_write", "title", MAX_TITLE);
      const content = strField(args, "memory_write", "content", MAX_CONTENT);
      const tags = tagsField(args, "memory_write") ?? [];
      let embedding: number[] | undefined;
      try {
        // E5: indexed documents use the "passage" role prefix.
        embedding = await embeds.embedOne(`${title}\n${content}`, "passage");
      } catch {
        embedding = undefined; // FTS-only row, vector degraded but write succeeds
      }
      const row = await writer.insertMemory({ title, content, tags, embedding });
      return { ...row, vectorStored: Boolean(embedding) };
    },

    async memory_search(args: SearchInput) {
      assertRecord(args, "memory_search");
      const query = optStrField(args, "memory_search", "query", MAX_QUERY);
      if (!query) {
        throw new Error(
          "memory_search: 'query' is required and must be non-empty. Examples: 'Workspace_Global_Rules', 'sqlite WAL busy_timeout'."
        );
      }
      const limit = numField(args, "memory_search", "limit", 10, 1, 50);
      const tags = tagsField(args, "memory_search");
      let vecHits: MemoryRow[] = [];
      let vectorDegraded = false;
      try {
        // E5: search queries use the "query" role prefix.
        const v = await embeds.embedOne(query, "query");
        vecHits = vecSearch(db, v, limit, tags).map((r) => ({
          id: r.id,
          title: r.title,
          content: r.content,
          tags: r.tags,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
      } catch {
        vectorDegraded = true;
      }
      // Skip FTS when nothing searchable remains after sanitizing (e.g. query of only punctuation).
      const ftsQuery = sanitizeQuery(query);
      let ftsHits: MemoryRow[] = [];
      if (ftsQuery) {
        try {
          ftsHits = ftsSearch(db, ftsQuery, limit, tags).map((r) => ({
            id: r.id,
            title: r.title,
            content: r.content,
            tags: r.tags,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }));
        } catch {
          ftsHits = [];
        }
      }
      const merged = RRfMerge(
        vecHits.map((m, i) => ({ m, score: i })),
        ftsHits.map((m, i) => ({ m, score: i })),
        limit
      );
      return { results: merged, vectorDegraded };
    },

    async memory_list(args: ListInput) {
      assertRecord(args, "memory_list");
      const limit = numField(args, "memory_list", "limit", 20, 1, 100);
      const rawOffset = args.offset;
      const offset =
        rawOffset === undefined ? 0 : numField(args, "memory_list", "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      return listMemories(db, limit, offset, tagsField(args, "memory_list"));
    },
  };
}
