// NOTE: MCP SDK >=1.x stdio transport uses newline-delimited JSON (no Content-Length framing).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "watcher.js");
const serverArgs = ["--jitless", "--optimize-for-size", "--max-old-space-size=64"];

function send(child, id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

const child = spawn("node", [...serverArgs, serverPath], { stdio: ["pipe", "pipe", "inherit"] });
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
    } catch {
      /* ignore partial */
    }
  }
});

const wait = (id, t = 90000) =>
  new Promise((res, rej) => {
    const s = Date.now();
    const poll = () => {
      if (results.has(id)) return res(results.get(id));
      if (Date.now() - s > t) return rej(new Error("timeout id=" + id));
      setTimeout(poll, 100);
    };
    poll();
  });

await new Promise((r) => setTimeout(r, 800));
send(child, 1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
});
await wait(1, 15000);
console.log("initialize OK");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
send(child, 2, "tools/list", {});
console.log("tools:", JSON.stringify((await wait(2)).result?.tools?.map((t) => t.name)));
send(child, 3, "tools/call", {
  name: "memory_write",
  arguments: { title: "probe", content: "hello minimal memory", tags: ["project:test"] },
});
console.log("write:", JSON.stringify((await wait(3)).result).slice(0, 400));
send(child, 4, "tools/call", {
  name: "memory_search",
  arguments: { query: "hello memory", limit: 5 },
});
console.log("search:", JSON.stringify((await wait(4)).result).slice(0, 800));
send(child, 5, "tools/call", {
  name: "memory_list",
  arguments: { limit: 5 },
});
console.log("list:", JSON.stringify((await wait(5)).result).slice(0, 800));
child.kill();
process.exit(0);
