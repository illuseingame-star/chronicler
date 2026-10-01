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
      JSON.stringify({ error: "Cloudflare D1 Database 'DB'가 바인딩되지 않았습니다." }),
      { status: 500, headers: corsHeaders }
    );
  }

  // 테이블 생성
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS chronicler_mcp (id TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)"
  ).run();

  try {
    // 1. GET: 저장된 모든 데이터/세션 불러오기
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT data FROM chronicler_mcp WHERE id = 'global_state'"
      ).all();

      if (results && results.length > 0) {
        return new Response(results[0].data, { headers: corsHeaders });
      } else {
        return new Response(JSON.stringify({ state: "empty" }), { headers: corsHeaders });
      }
    }

    // 2. POST: 세션 및 카드 데이터 저장하기
    if (request.method === "POST") {
      const bodyText = await request.text();
      await env.DB.prepare(
        "INSERT INTO chronicler_mcp (id, data, updated_at) VALUES ('global_state', ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
      ).bind(bodyText, Date.now()).run();

      return new Response(
        JSON.stringify({ jsonrpc: "2.0", result: { status: "success" }, id: 1 }),
        { headers: corsHeaders }
      );
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders,
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
}
