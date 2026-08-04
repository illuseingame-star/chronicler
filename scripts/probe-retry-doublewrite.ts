// Does retryOnBackpressure double-write?
//
// Failure mode under test: the server COMMITS the write, then the response
// is lost (timeout / dropped connection / queue-full raised after commit).
// A naive retry fires again → two durable rows for one logical fact.
//
// Before idempotency keys this printed "3 durable writes for 1 logical
// fact". The engine gained idempotency keys in v0.10; the client now
// allocates one BEFORE the retry loop so every attempt presents the same
// key. This script is the regression guard for that.
//
// Run:  npx tsx scripts/probe-retry-doublewrite.ts

import { YantrikClient, type YantrikDBTransport } from "../src/lib/yantrikdb/client";

/** Server that always commits, but reports queue_full for the first N
 *  calls — the "succeeded but you didn't hear about it" shape. Honors
 *  idempotency keys the way the v0.10 engine does: a repeat key returns
 *  the ORIGINAL rid and does not write again. */
function committingServer(failFirst: number) {
  const durable = new Map<string, { rid: string; text: string }>();
  let calls = 0;
  const transport: YantrikDBTransport = {
    async call(_tool, args) {
      calls++;
      const a = args as {
        text?: string;
        idempotency_key?: string;
        memories?: Array<{ text?: string; idempotency_key?: string }>;
      };

      /** Engine semantics: same key → original rid, no second write. */
      const upsert = (key: string | undefined, text: string): string => {
        if (key && durable.has(key)) return durable.get(key)!.rid;
        const rid = `rid-${durable.size + 1}`;
        durable.set(key ?? `nokey-${calls}-${durable.size}`, { rid, text });
        return rid;
      };

      // Batch shape: one row per item, each with its own index-scoped key.
      if (Array.isArray(a.memories)) {
        const rids = a.memories.map((m) =>
          upsert(m.idempotency_key, m.text ?? "(none)")
        );
        if (calls <= failFirst) {
          return {
            result:
              "Error executing tool remember: ingest queue full (256 pending ops, max=256); retry after 5ms",
          };
        }
        return { result: JSON.stringify({ rids, count: rids.length, status: "recorded" }) };
      }

      const rid = upsert(a.idempotency_key, a.text ?? "(none)");
      if (calls <= failFirst) {
        return {
          result:
            "Error executing tool remember: ingest queue full (256 pending ops, max=256); retry after 5ms",
        };
      }
      return { result: JSON.stringify({ rid, status: "recorded" }) };
    },
  };
  return { transport, durable, callCount: () => calls };
}

async function main(): Promise<void> {
  console.log("Retry double-write probe\n");
  let failed = false;

  // ── Case 1: single remember, two lost responses after commit ──
  {
    const { transport, durable, callCount } = committingServer(2);
    const client = new YantrikClient(transport);
    const { rid } = await client.remember({
      text: "Ren promised to meet Pranab at the lighthouse Saturday at dusk.",
      namespace: "probe",
      metadata: {},
    });
    console.log(`remember(): client saw rid=${rid} after ${callCount()} transport calls`);
    console.log(`  durable rows: ${durable.size}`);
    for (const [k, v] of durable) console.log(`    ${k.slice(0, 24)}… → ${v.rid}`);
    if (durable.size !== 1) {
      failed = true;
      console.log(`  ✗ FAIL — ${durable.size} rows for 1 logical fact\n`);
    } else {
      console.log(`  ✓ exactly one durable row despite ${callCount()} calls\n`);
    }
  }

  // ── Case 2: retrying the SAME batch operation must not duplicate ──
  {
    const { transport, durable } = committingServer(0);
    const client = new YantrikClient(transport);
    const rows = [
      { text: "Pranab's cat is named Kiku", namespace: "probe", metadata: {} },
      { text: "Pranab grew up in Oji", namespace: "probe", metadata: {} },
    ];
    const opId = "extraction-turn-7";
    await client.rememberBatch(rows, { operation_id: opId });
    await client.rememberBatch(rows, { operation_id: opId }); // caller retry
    console.log(`rememberBatch() replayed with the same operation_id`);
    console.log(`  durable rows: ${durable.size} (expected 2, one per distinct fact)`);
    if (durable.size !== 2) {
      failed = true;
      console.log(`  ✗ FAIL — replay duplicated the batch\n`);
    } else {
      console.log(`  ✓ replay collapsed onto the original rows\n`);
    }
  }

  // ── Case 3: distinct operations must still write distinct rows ──
  {
    const { transport, durable } = committingServer(0);
    const client = new YantrikClient(transport);
    await client.remember({ text: "fact A", namespace: "probe", metadata: {} });
    await client.remember({ text: "fact B", namespace: "probe", metadata: {} });
    console.log(`two independent remember() calls`);
    console.log(`  durable rows: ${durable.size} (expected 2)`);
    if (durable.size !== 2) {
      failed = true;
      console.log(`  ✗ FAIL — over-collapsed; distinct facts were merged\n`);
    } else {
      console.log(`  ✓ distinct operations remain distinct\n`);
    }
  }

  console.log("═".repeat(56));
  if (failed) {
    console.log("✗ FAIL — exactly-once is not holding.");
    process.exit(1);
  }
  console.log("✓ PASS — exactly-once holds under lost responses and replay.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
