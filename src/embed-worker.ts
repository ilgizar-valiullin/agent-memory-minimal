/**
 * Heavy embedding worker. Loaded ONLY via child_process.fork from EmbedManager.
 * Parent (MCP stdio watcher) stays thin; this process holds transformers+onnx.
 * E5 models REQUIRE role prefixes: "query: " for search queries,
 * "passage: " for indexed documents (same pattern as mcp-search).
 * IPC protocol:
 *   parent -> child: { id: number, texts: string[], prefix: "query" | "passage" }
 *   child -> parent: { id: number, ok: true, vectors: number[][] }
 *                     { id: number, ok: false, error: string }
 */
import { EMBED_BATCH_SIZE, EMBED_MODEL, MODEL_CACHE_DIR } from "./config.js";

export type EmbedPrefix = "query" | "passage";

type Req = { id: number; texts: string[]; prefix?: EmbedPrefix };
type Res =
  | { id: number; ok: true; vectors: number[][] }
  | { id: number; ok: false; error: string };

type Extractor = (
  texts: string[],
  opts: unknown
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

let extractor: Extractor | null = null;

async function ensureExtractor(): Promise<Extractor> {
  if (extractor) return extractor;
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.cacheDir = MODEL_CACHE_DIR;
  env.localModelPath = MODEL_CACHE_DIR;
  extractor = (await pipeline("feature-extraction", EMBED_MODEL, {
    local_files_only: true,
  })) as unknown as Extractor;
  return extractor;
}

async function embedBatch(texts: string[], prefix: EmbedPrefix): Promise<number[][]> {
  const pipe = await ensureExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const chunk = texts
      .slice(i, i + EMBED_BATCH_SIZE)
      .map((t) => `${prefix}: ${t}`);
    const res = await pipe(chunk, { pooling: "mean", normalize: true });
    const dim = res.dims[res.dims.length - 1];
    const data = Array.from(res.data);
    const n = res.dims.length === 1 ? 1 : chunk.length;
    for (let j = 0; j < n; j++) {
      out.push(data.slice(j * dim, (j + 1) * dim));
    }
  }
  return out;
}

process.on("message", async (msg: Req) => {
  if (typeof process.send !== "function") {
    // Running without IPC (e.g. node embed-worker.js directly): cannot reply.
    console.error("embed-worker: no IPC channel, ignoring message. Run only via EmbedManager fork().");
    return;
  }
  if (!msg || typeof msg.id !== "number" || !Array.isArray(msg.texts)) {
    (process.send as Function)({
      id: typeof msg?.id === "number" ? msg.id : -1,
      ok: false,
      error: "malformed request: expected {id: number, texts: string[], prefix?: 'query'|'passage'}",
    } satisfies Res);
    return;
  }
  const prefix: EmbedPrefix = msg.prefix === "passage" ? "passage" : "query";
  try {
    const vectors = await embedBatch(msg.texts, prefix);
    (process.send as Function)({ id: msg.id, ok: true, vectors } satisfies Res);
  } catch (e) {
    (process.send as Function)({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies Res);
  }
});

// Ready handshake: parent waits for 'ready' before sending work.
// NOTE: model itself loads lazily on first embed, not here.
process.send?.({ ready: true });
