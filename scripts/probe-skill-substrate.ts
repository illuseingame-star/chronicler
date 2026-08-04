// Is the skill substrate actually accepting writes?
//
// The replay harness found ZERO skills after defining six, and engine stats
// have shown skill_defines_accepted: 0 since the first probe today. This
// checks define -> list -> get end to end and prints the raw responses.

import { McpTransport } from "../src/lib/yantrikdb/mcp-transport";
import { YantrikClient } from "../src/lib/yantrikdb/client";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";
const CHAR = `skillprobe-${Date.now().toString(36)}`;
const SKILL_ID = `probe.observation_led_${Date.now().toString(36)}`;

const t = new McpTransport({ kind: "streamable-http", url: STACK });
const client = new YantrikClient(t);

console.log("1. raw skill define");
const raw = await t.call("skill", {
  action: "define",
  skill_id: SKILL_ID,
  body: "Ren is fundamentally observation-led. Speaking is something Ren does after watching the room, never the opening move; silence is always an option.",
  skill_type: "pattern",
  applies_to: [CHAR],
  on_conflict: "replace",
});
console.log("   ", JSON.stringify(raw).slice(0, 400), "\n");

console.log("2. raw skill get");
const got = await t.call("skill", { action: "get", skill_id: SKILL_ID });
console.log("   ", JSON.stringify(got).slice(0, 400), "\n");

console.log("3. raw skill list (applies_to filter)");
const listed = await t.call("skill", { action: "list", applies_to: [CHAR], limit: 20 });
console.log("   ", JSON.stringify(listed).slice(0, 400), "\n");

console.log("4. raw skill list (no filter)");
const listedAll = await t.call("skill", { action: "list", limit: 5 });
console.log("   ", JSON.stringify(listedAll).slice(0, 400), "\n");

console.log("5. typed client skillList");
console.log("   ", JSON.stringify(await client.skillList({ applies_to: [CHAR], limit: 20 })).slice(0, 300), "\n");

console.log("6. record an outcome, then get");
await t.call("skill", { action: "outcome", skill_id: SKILL_ID, succeeded: true, note: "probe" });
console.log("   ", JSON.stringify(await t.call("skill", { action: "get", skill_id: SKILL_ID })).slice(0, 400), "\n");

console.log("7. engine skill counters");
const stats = await t.call("stats", { action: "stats" });
const s = JSON.parse((stats as { result: string }).result) as Record<string, unknown>;
console.log("   ", JSON.stringify(s.skill_substrate).slice(0, 400));

await t.close();
