// Probe the v0.11 pack substrate through the MCP surface.
//
// Packs matter to Chronicler because their tier model is the same finding
// Phase 11 measured independently:
//   constitution — injected unconditionally  = ability   (our <character_identity>)
//   corpus       — retrieved by similarity   = knowledge (our canon recall)
// Upstream measured constitution +5/+4/+5 vs retrieval +1/+1/+0 across
// 8 ability tasks × 3 models.
//
// Registration is feature-probed upstream: the `pack` tool is ABSENT on an
// engine without pack support rather than present-and-failing. So the
// presence of the tool is itself the capability assertion.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";

async function main(): Promise<void> {
  const client = new Client({ name: "packprobe", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(STACK)));

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`tools exposed: ${names.length}`);
  const pack = tools.find((t) => t.name === "pack");
  if (!pack) {
    console.log("✗ `pack` tool ABSENT — engine lacks pack substrate (feature-probed registration)");
    console.log(`   exposed: ${names.join(", ")}`);
    await client.close();
    process.exit(1);
  }
  console.log("✓ `pack` tool PRESENT — engine carries the pack substrate\n");
  console.log(pack.description?.slice(0, 700) ?? "(no description)");

  const schema = pack.inputSchema as {
    properties?: Record<string, { type?: string; description?: string }>;
  };
  if (schema?.properties) {
    console.log(`\nPARAMS:`);
    for (const [n, s] of Object.entries(schema.properties)) {
      console.log(`  ${n}: ${s.type ?? "?"}${s.description ? ` — ${s.description.slice(0, 90)}` : ""}`);
    }
  }

  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "pack", arguments: args });
    const content = (res as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  };

  // Read actions are always available; write actions are operator-gated
  // behind YANTRIKDB_ENABLE_PACK_WRITES=1 and should refuse by naming it.
  for (const action of ["list", "publishers", "embedder_identity"]) {
    try {
      console.log(`\n── pack.${action} ──\n${(await call({ action })).slice(0, 400)}`);
    } catch (e) {
      console.log(`\n── pack.${action} ── failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }

  // Confirm the write gate refuses cleanly rather than half-applying.
  try {
    const out = await call({ action: "mount", pack_id: "nonexistent-probe-pack" });
    console.log(`\n── pack.mount (expect operator-gate refusal) ──\n${out.slice(0, 400)}`);
  } catch (e) {
    console.log(`\n── pack.mount (expect refusal) ──\n${e instanceof Error ? e.message.slice(0, 400) : String(e)}`);
  }

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
