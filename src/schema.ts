/**
 * Tool schemas only — zero dependencies.
 * Imported by index.ts at startup so tools/list answers instantly
 * without loading better-sqlite3 / sqlite-vec / transformers.
 * Handlers live in tools.ts and are loaded lazily on first tools/call.
 */
export function toolSchemas() {
  return [
    {
      name: "memory_write",
      description:
        "Persist ONE reusable fact after meaningful work: an architectural decision, bug fix, learned pattern, or session handoff. Call once per fact, not once per session. Do NOT save status spam, scratch reasoning, duplicate summaries, or low-value transcripts. Every record must carry a project tag (project:<name>); workspace rules live under Workspace_Global_Rules, open work under Active_Tasks, dataset decisions as Dataset_Decision_<Topic> with SCOPE/RULE/SOURCES/RATIONALE/SUPERSEDES/DATE fields.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          title: {
            type: "string",
            description:
              "Short stable title. Prefix with [ProjectName] or use Dataset_Decision_<Topic> for dataset decisions. Example: '[MyProj] STATUS: done | CHANGED: X | NEXT: Y'.",
          },
          content: {
            type: "string",
            description:
              "The fact itself, self-contained: what was decided/done and why.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Mandatory project scope as namespace:value, e.g. ['project:myproj']. Optional extras: team:<name>, type:decision|bugfix|pattern|handoff. Tag format is always <namespace>:<value>, never free text.",
          },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "memory_search",
      description:
        "Recall relevant facts before deciding or coding: session startup sync (Workspace_Global_Rules, Active_Tasks, Dataset_Decision_*), reusing past decisions, or checking how a file was handled before. Hybrid keyword + multilingual vector search (English and Russian queries both work); falls back to keyword-only with vectorDegraded:true when the embedding worker is unavailable. Prefer narrow tag-filtered queries over broad ones.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              "Keywords or a short phrase: concept names, file paths, error text, decision topics. Examples: 'Workspace_Global_Rules', 'sqlite WAL busy_timeout', 'Dataset_Decision_Embeddings'. No filler sentences — 2-6 content words beat a paragraph.",
          },
          limit: {
            type: "number",
            description: "Max results, 1-50. Default 10. Keep small: 3-5 for startup sync, up to 20 for investigation.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Narrow results to a project/scope, e.g. ['project:myproj']. Use for startup sync to avoid cross-project noise.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_list",
      description:
        "Browse the most recent facts, optionally filtered by tags. Cheap call: never loads the embedding model, use it for overviews and audits instead of memory_search when no query is needed.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Page size, 1-100. Default 20.",
          },
          offset: {
            type: "number",
            description: "Skip N newest rows for pagination. Default 0.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Only rows carrying ALL listed tags, e.g. ['project:myproj']. Omit for a global recent feed.",
          },
        },
      },
    },
  ];
}
