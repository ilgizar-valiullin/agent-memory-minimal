// Usage:
//   1. When old agentmemory backend is up: obtain export JSON via memory_export
//      and save as export.json (array of {title, content, tags}).
//   2. node scripts/migrate.mjs export.json [--dry-run]
// Imports only Workspace_Global_Rules / Active_Tasks / Dataset_Decision_* records
// through the new server's memory_write (so embeddings are computed).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "index.js");

const KEEP = [/Workspace_Global_Rules/i, /Active_Tasks/i, /Dataset_Decision_/i];
const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file) {
  console.error("usage: node scripts/migrate.mjs <export.json> [--dry-run]");
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const items = Array.isArray(raw) ? raw : raw.items || raw.memories || [];
const keep = items.filter((it) => {
  const hay = `${it.title || ""} ${(it.tags || []).join(" ")} ${it.content || ""}`;
  return KEEP.some((re) => re.test(hay));
});
console.log(`export: ${items.length}, keep: ${keep.length}`);
if (dryRun) {
  for (const k of keep.slice(0, 20)) console.log(" -", k.title, JSON.stringify(k.tags));
  process.exit(0);
}

const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
let text = "";
const results = new Map();
child.stdout.on("data", (c) => {
  text += c.toString();
  let idx;
  while ((idx = text.indexOf("\n")) !== -1) {
    const line = text.slice(0, idx).trim();
    text = text.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null) results.set(msg.id, msg);
    } catch { /* ignore */ }
  }
});
const wait = (id, t = 120000) =>
  new Promise((res, rej) => {
    const s = Date.now();
    const poll = () => {
      if (results.has(id)) return res(results.get(id));
      if (Date.now() - s > t) return rej(new Error("timeout id=" + id));
      setTimeout(poll, 200);
    };
    poll();
  });
const send = (id, method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

await new Promise((r) => setTimeout(r, 800));
send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "migrate", version: "0" } });
await wait(1, 15000);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
let ok = 0, fail = 0, skipped = 0;
let id = 10;
for (const k of keep) {
  const title = typeof k.title === "string" ? k.title.trim() : "";
  const content = typeof k.content === "string" ? k.content.trim() : "";
  const tags = Array.isArray(k.tags) ? k.tags.filter((t) => typeof t === "string" && t.trim()) : [];
  if (!title || !content) {
    skipped++;
    console.error(`SKIP: empty ${!title ? "title" : "content"} in export record (keys: ${Object.keys(k).join(",")})`);
    continue;
  }
  send(id, "tools/call", {
    name: "memory_write",
    arguments: { title, content, tags },
  });
  try {
    const r = await wait(id, 120000);
    if (r.result) ok++;
    else { fail++; console.error("FAIL:", k.title, JSON.stringify(r).slice(0, 200)); }
  } catch (e) { fail++; console.error("TIMEOUT:", k.title); }
  id++;
}
console.log(`migrated ok=${ok} fail=${fail} skipped=${skipped}`);
child.kill();
process.exit(fail ? 1 : 0);
