// List all tools YantrikDB exposes over MCP. Diffs against what
// chronicler's YantrikClient knows about, so a version upgrade that
// adds tools (or removes them) is visible.

import { McpTransport } from "../src/lib/yantrikdb/mcp-transport";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";

// Tools chronicler's YantrikClient currently wraps (from client.ts).
const KNOWN_TOOLS = new Set([
  "remember",
  "recall",
  "correct",
  "forget",
  "conflict",
  "category",
  "graph",
  "think",
  "personality",
  "session",
  "temporal",
  "trigger",
  "procedure",
  "skill",
  "stats",
  "memory",
]);

async function main(): Promise<void> {
  const client = new Client({ name: "probe", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(STACK));
  await client.connect(transport);
  const result = await client.listTools();
  const names = result.tools.map((t) => t.name).sort();
  console.log(`YantrikDB exposes ${names.length} tools:`);
  for (const n of names) {
    const marker = KNOWN_TOOLS.has(n) ? " " : "★"; // ★ = new / unknown
    console.log(`  ${marker} ${n}`);
  }
  const newTools = names.filter((n) => !KNOWN_TOOLS.has(n));
  const missingTools = Array.from(KNOWN_TOOLS).filter((n) => !names.includes(n));
  console.log(`\nnew (★) — not wrapped by chronicler: ${newTools.length ? newTools.join(", ") : "none"}`);
  console.log(`missing — client references but server no longer exposes: ${missingTools.length ? missingTools.join(", ") : "none"}`);

  // Dump signatures for the new tools so we can see what they do.
  for (const name of newTools) {
    const tool = result.tools.find((t) => t.name === name);
    if (!tool) continue;
    console.log(`\n── ${name} ──`);
    console.log(`description: ${tool.description?.slice(0, 400) ?? "(no description)"}${tool.description && tool.description.length > 400 ? "…" : ""}`);
    const schema = tool.inputSchema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
    if (schema?.properties) {
      const params = Object.entries(schema.properties);
      console.log(`params (${params.length}):`);
      for (const [pname, pschema] of params.slice(0, 8)) {
        console.log(`  ${pname}${schema.required?.includes(pname) ? "*" : ""}: ${pschema.type ?? "?"} — ${pschema.description?.slice(0, 100) ?? ""}`);
      }
      if (params.length > 8) console.log(`  … and ${params.length - 8} more`);
    }
  }
  await client.close();
  void McpTransport; // keep import for future use
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
