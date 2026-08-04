// Full schema dump for YantrikDB MCP tools. Used to spot what a core
// upgrade added — new tools AND new actions on existing tools.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";
const ONLY = process.env.ONLY?.split(",").map((s) => s.trim());

async function main(): Promise<void> {
  const client = new Client({ name: "probe", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(STACK)));
  const { tools } = await client.listTools();
  for (const tool of tools) {
    if (ONLY && !ONLY.includes(tool.name)) continue;
    console.log(`\n${"=".repeat(72)}`);
    console.log(`TOOL: ${tool.name}`);
    console.log("=".repeat(72));
    console.log(tool.description ?? "(no description)");
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
      required?: string[];
    };
    if (schema?.properties) {
      console.log(`\nPARAMS:`);
      for (const [name, s] of Object.entries(schema.properties)) {
        const req = schema.required?.includes(name) ? "*" : "";
        const en = s.enum ? ` enum=${JSON.stringify(s.enum)}` : "";
        console.log(`  ${name}${req}: ${s.type ?? "?"}${en}${s.description ? ` — ${s.description}` : ""}`);
      }
    }
  }
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
