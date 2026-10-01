export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (!env.DB) {
    return new Response(
      JSON.stringify({ error: "D1 database 'DB' is not bound." }),
      { status: 500, headers: corsHeaders }
    );
  }

  // D1 테이블 초기화
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS yantrik_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
  ).run();

  try {
    // GET 요청: 상태 체크 또는 데이터 동기화
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT value FROM yantrik_store WHERE key = 'mcp_state'"
      ).all();

      if (results && results.length > 0) {
        return new Response(results[0].value, { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ status: "ok", memories: [] }), { headers: corsHeaders });
    }

    // POST 요청: Chronicler McpTransport 통신
    if (request.method === "POST") {
      const bodyText = await request.text();
      let body = {};
      try { body = JSON.parse(bodyText); } catch (e) {}

      // Chronicler 클라이언트의 요청 저장
      await env.DB.prepare(
        "INSERT INTO yantrik_store (key, value, updated_at) VALUES ('mcp_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(bodyText, Date.now()).run();

      // MCP Protocol Response 형식 반환
      const responsePayload = {
        jsonrpc: "2.0",
        id: body.id || 1,
        result: {
          status: "ok",
          memories: [],
          sessions: [],
          message: "Data synced to D1 successfully"
        }
      };

      return new Response(JSON.stringify(responsePayload), { headers: corsHeaders });
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
}
