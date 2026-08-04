// Exercise every v0.9.0 YantrikDB capability Chronicler does NOT yet use,
// against the live server, so we recommend from evidence not from docs.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";
const NS = `v09probe-${Date.now().toString(36)}`;

let client: Client;

async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await client.callTool({ name: tool, arguments: args });
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  if (text.startsWith("Error executing tool")) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

function show(label: string, v: unknown, chars = 500): void {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  console.log(`${label}:\n${s.slice(0, chars)}${s.length > chars ? "\n  …(truncated)" : ""}\n`);
}

async function section(name: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`\n${"█".repeat(70)}\n██ ${name}\n${"█".repeat(70)}`);
  try { await fn(); console.log(`✓ ${name} WORKS`); return true; }
  catch (e) { console.log(`✗ ${name} FAILED: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`); return false; }
}

async function main(): Promise<void> {
  client = new Client({ name: "v09probe", version: "0.1.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(STACK)));
  console.log(`namespace: ${NS}\n`);
  const results: Record<string, boolean> = {};

  // ── 1. session digest — one-call boot briefing ────────────────────
  results["session digest"] = await section("session digest (boot-time briefing)", async () => {
    const d = await call("session", { action: "digest", namespace: NS, max_decisions: 3, max_conflicts: 3, max_triggers: 3, snippet_chars: 120 });
    show("digest", d, 900);
  });

  // ── 2. knowledge gaps — the substrate's known unknowns ────────────
  results["gaps"] = await section("gaps (known unknowns / demand log)", async () => {
    // Ask the same unanswerable question repeatedly to create a gap.
    for (let i = 0; i < 4; i++) {
      await call("recall", { query: "what is Ren's mother's name", top_k: 3, namespace: NS });
    }
    const g = await call("gaps", { min_count: 1, max_avg_top_score: 0.9, limit: 10 });
    show("gaps", g, 900);
  });

  // ── 3. conversation ring buffer ───────────────────────────────────
  results["conversation"] = await section("conversation (verbatim working-memory ring)", async () => {
    await call("conversation", { action: "record", namespace: NS, role: "user", content: "Do you remember the lighthouse?", max_turns: 6 });
    await call("conversation", { action: "record", namespace: NS, role: "assistant", content: "Ren nods. 'Saturday, at dusk.'", max_turns: 6 });
    const recent = await call("conversation", { action: "recent", namespace: NS, limit: 5 });
    show("recent turns", recent, 600);
  });

  // ── 4. task store — deferred follow-through ───────────────────────
  results["task"] = await section("task (substrate-backed commitments)", async () => {
    const added = await call("task", { action: "add", namespace: NS, title: "Meet Pranab at the lighthouse Saturday at dusk", priority: "high" });
    show("added", added, 300);
    const list = await call("task", { action: "list", namespace: NS, status: "open" });
    show("open tasks", list, 600);
  });

  // ── 5. record-to-record links + link-expanded recall ──────────────
  results["record links"] = await section("graph record_link + recall_with_links", async () => {
    const a = (await call("remember", { text: "Ren promised to meet Pranab at the lighthouse on Saturday at dusk.", namespace: NS, importance: 0.8 })) as { rid: string };
    const b = (await call("remember", { text: "The lighthouse at Port Lyra has been unmanned since the storm.", namespace: NS, importance: 0.6 })) as { rid: string };
    show("rids", { a: a.rid, b: b.rid }, 200);
    const linked = await call("graph", { action: "record_link", source_rid: a.rid, target_rid: b.rid, link_type: "concerns" });
    show("record_link", linked, 300);
    const traversed = await call("graph", { action: "linked_records", rid: a.rid, direction: "both" });
    show("linked_records", traversed, 600);
    const expanded = await call("graph", { action: "recall_with_links", query: "lighthouse meeting", top_k: 3, expand_links: 2, namespace: NS });
    show("recall_with_links", expanded, 800);
  });

  // ── 6. autonomous maintenance cycle (dry run) ─────────────────────
  results["maintenance_cycle"] = await section("think maintenance_cycle (dry run)", async () => {
    const m = await call("think", { maintenance_cycle: true, dry_run: true });
    show("cycle preview", m, 900);
  });

  // ── 7. skill outcomes telemetry ───────────────────────────────────
  results["stats skill_outcomes"] = await section("stats skill_outcomes", async () => {
    const s = await call("stats", { action: "skill_outcomes" });
    show("skill outcomes", s, 400);
  });

  console.log(`\n${"═".repeat(70)}\nSUMMARY\n${"═".repeat(70)}`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${v ? "✓" : "✗"} ${k}`);
  const working = Object.values(results).filter(Boolean).length;
  console.log(`\n${working}/${Object.keys(results).length} v0.9.0 capabilities verified working`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
