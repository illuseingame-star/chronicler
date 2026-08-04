// Does retryOnBackpressure double-write?
//
// Failure mode under test: the server COMMITS the write, then the response
// is lost (timeout / dropped connection / queue-full raised after commit).
// Our retry fires again → two memories for one logical fact.
//
// Simulated with a transport that commits on every call but reports
// queue_full for the first N — exactly the "succeeded but you didn't hear
// about it" shape.

import { YantrikClient, type YantrikDBTransport } from "../src/lib/yantrikdb/client";

async function main(): Promise<void> {
  const committed: string[] = [];
  let call_n = 0;

  const transport: YantrikDBTransport = {
    async call(_tool, args) {
      call_n++;
      // The server always durably commits...
      const text = (args as { text?: string }).text ?? "(batch)";
      committed.push(text);
      // ...but the first two calls report queue_full to the client.
      if (call_n <= 2) {
        return { result: "Error executing tool remember: ingest queue full (256 pending ops, max=256); retry after 5ms" };
      }
      return { result: `{"rid":"rid-${call_n}","status":"recorded"}` };
    },
  };

  const client = new YantrikClient(transport);
  const { rid } = await client.remember({
    text: "Ren promised to meet Pranab at the lighthouse Saturday at dusk.",
    metadata: {},
  });

  console.log(`client saw ONE success: rid=${rid}`);
  console.log(`server actually committed ${committed.length} copies:`);
  committed.forEach((c, i) => console.log(`  ${i + 1}. ${c.slice(0, 60)}…`));

  if (committed.length > 1) {
    console.log(`\n✗ CONFIRMED BUG — ${committed.length} durable writes for 1 logical fact.`);
    console.log(`   An idempotency key (v0.10 engine) makes the retry return the ORIGINAL rid`);
    console.log(`   with zero additional writes. We are on 0.9.4, which has no such key.`);
  } else {
    console.log(`\n✓ no duplication`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
