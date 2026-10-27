import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appDir =
  process.env.AGENT_MEMORY_DIR ||
  (process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "agent-memory-minimal")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "agent-memory-minimal")
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "agent-memory-minimal"));
const cacheDir = process.env.AGENT_MEMORY_MODEL_CACHE || path.join(appDir, "models");
const model = process.env.AGENT_MEMORY_MODEL || "Xenova/multilingual-e5-small";

fs.mkdirSync(cacheDir, { recursive: true });

const { pipeline, env } = await import("@xenova/transformers");
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.cacheDir = cacheDir;
env.localModelPath = cacheDir;

console.log(`[bootstrap] model=${model} cache=${cacheDir}`);
const extractor = await pipeline("feature-extraction", model, {
  progress_callback: (e) => {
    if (e?.status === "download" || e?.status === "done")
      console.log(`[bootstrap] ${e.status}: ${e.file || "asset"}`);
  },
});
await extractor(["bootstrap probe"], { pooling: "mean", normalize: true });
env.allowRemoteModels = false;
console.log("[bootstrap] ready (runtime must use allowRemoteModels=false)");
