// Raw engine response shape for remember(), with and without an
// idempotency_key. Diagnostic only.
import { McpTransport } from "../src/lib/yantrikdb/mcp-transport";

const t = new McpTransport({
  kind: "streamable-http",
  url: process.env.CHRONICLER_URL ?? "http://127.0.0.1:3001/api/mcp",
});
const ns = `raw-${Date.now().toString(36)}`;

const withKey = await t.call("remember", {
  text: "probe with key",
  namespace: ns,
  idempotency_key: "k1",
});
console.log("WITH key   :", JSON.stringify(withKey).slice(0, 400));

const again = await t.call("remember", {
  text: "probe with key",
  namespace: ns,
  idempotency_key: "k1",
});
console.log("REPEAT key :", JSON.stringify(again).slice(0, 400));

const noKey = await t.call("remember", { text: "probe no key", namespace: ns });
console.log("WITHOUT key:", JSON.stringify(noKey).slice(0, 400));

await t.close();
