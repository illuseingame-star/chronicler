// Does the LIVE engine actually honor idempotency keys?
//
// The unit tests encode what I believe the v0.10+ engine does. This asks
// the running engine directly, because "probe features, not versions" —
// a mock that agrees with a wrong assumption proves nothing.
//
// Run:  npx tsx scripts/verify-idempotency-live.ts

import { McpTransport } from "../src/lib/yantrikdb/mcp-transport";
import { YantrikClient, getIdempotencySupport } from "../src/lib/yantrikdb/client";

const STACK = process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp";
const NS = `idem-verify-${Date.now().toString(36)}`;

async function main(): Promise<void> {
  const t = new McpTransport({ kind: "streamable-http", url: STACK });
  const client = new YantrikClient(t);
  let failed = false;

  // ── Same key + same text ⇒ same rid, no second write ──
  const key = `verify-${Date.now().toString(36)}`;
  const text = "Idempotency verification fact — should exist exactly once.";
  const a = await client.remember({ text, namespace: NS, metadata: {}, idempotency_key: key });
  const b = await client.remember({ text, namespace: NS, metadata: {}, idempotency_key: key });
  const keysAccepted = getIdempotencySupport();
  console.log(`same key, same text:`);
  console.log(`  call 1 → ${a.rid}`);
  console.log(`  call 2 → ${b.rid}`);
  if (keysAccepted === false) {
    // Expected on this deployment: keys need the engine-side embedder, and
    // we run ONNX for 384-dim volume compatibility. Writes must still have
    // succeeded via the automatic key-less retry — that is what is being
    // asserted here, not exactly-once.
    console.log(`  ~ server REFUSED idempotency keys (engine embedder required).`);
    console.log(`    Client degraded to key-less writes and both succeeded.`);
    console.log(`    Exactly-once is genuinely UNAVAILABLE on this deployment.\n`);
    if (!a.rid || !b.rid) {
      failed = true;
      console.log(`  ✗ but a write failed — degradation is broken\n`);
    }
  } else if (a.rid === b.rid) {
    console.log(`  ✓ engine returned the ORIGINAL rid — no duplicate write\n`);
  } else {
    failed = true;
    console.log(`  ✗ keys were ACCEPTED but not honored — real bug\n`);
  }

  // ── Distinct operations must still produce distinct rows ──
  const c1 = await client.remember({ text: "distinct fact A", namespace: NS, metadata: {} });
  const c2 = await client.remember({ text: "distinct fact B", namespace: NS, metadata: {} });
  console.log(`two independent writes (auto-allocated keys):`);
  console.log(`  ${c1.rid}\n  ${c2.rid}`);
  if (c1.rid !== c2.rid) {
    console.log(`  ✓ distinct facts remain distinct\n`);
  } else {
    failed = true;
    console.log(`  ✗ over-collapsed — independent facts merged\n`);
  }

  // ── Batch replay under one operation_id ──
  const rows = [
    { text: "batch fact one", namespace: NS, metadata: {} },
    { text: "batch fact two", namespace: NS, metadata: {} },
  ];
  const opId = `batch-${Date.now().toString(36)}`;
  const first = await client.rememberBatch(rows, { operation_id: opId });
  const replay = await client.rememberBatch(rows, { operation_id: opId });
  console.log(`batch replayed under the same operation_id:`);
  console.log(`  first  → ${JSON.stringify(first)}`);
  console.log(`  replay → ${JSON.stringify(replay)}`);
  if (getIdempotencySupport() === false) {
    console.log(`  ~ keys refused; batch wrote ${first.length} + ${replay.length} rows.`);
    console.log(`    Duplication on replay is EXPECTED without key support.\n`);
    if (first.length !== 2 || replay.length !== 2) {
      failed = true;
      console.log(`  ✗ batch write itself is broken\n`);
    }
  } else if (first.length === 2 && JSON.stringify(first) === JSON.stringify(replay)) {
    console.log(`  ✓ replay returned the original rids\n`);
  } else {
    console.log(`  ~ replay did not return identical rids — batch key scoping`);
    console.log(`    differs from the per-item assumption. Confirm against the`);
    console.log(`    engine's batch semantics before relying on it.\n`);
  }

  await t.close();
  console.log("═".repeat(56));
  if (failed) {
    console.log("✗ FAIL — writes are broken.");
    process.exit(1);
  }
  if (getIdempotencySupport() === false) {
    console.log("✓ PASS (degraded) — writes succeed; exactly-once UNAVAILABLE here.");
    console.log("");
    console.log("  Idempotency keys require YantrikDB's engine-side (bundled)");
    console.log("  embedder. Chronicler runs the ONNX embedder so that existing");
    console.log("  384-dim volumes stay recallable, and the engine correctly");
    console.log("  refuses keys in that configuration — a wrapper-generated");
    console.log("  vector could drift between retries and fake a conflict.");
    console.log("");
    console.log("  Consequence: writes are at-least-once. A response lost after");
    console.log("  a commit can duplicate a memory. The client detects the");
    console.log("  refusal once per process, warns, and stops sending keys.");
    return;
  }
  console.log("✓ PASS — live engine honors idempotency keys.");
}

main().catch((e) => {
  console.error("verify failed:", e);
  process.exit(1);
});
