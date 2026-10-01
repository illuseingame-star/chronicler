export async function onRequest(context) {
  const { request, env } = context;

  if (!env.DB) {
    return new Response(JSON.stringify({ error: "D1 Database 'DB' is not bound." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 테이블 자동 생성 (최초 1회)
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS chronicler_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
  ).run();

  // CORS 헤더 설정
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 1. 데이터 불러오기 (GET)
  if (request.method === "GET") {
    try {
      const { results } = await env.DB.prepare(
        "SELECT value FROM chronicler_store WHERE key = 'app_state'"
      ).all();

      if (results && results.length > 0) {
        return new Response(results[0].value, { headers: corsHeaders });
      } else {
        return new Response(JSON.stringify({ status: "empty" }), { headers: corsHeaders });
      }
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }

  // 2. 데이터 저장하기 (POST)
  if (request.method === "POST") {
    try {
      const body = await request.text();
      
      await env.DB.prepare(
        "INSERT INTO chronicler_store (key, value, updated_at) VALUES ('app_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(body, Date.now()).run();

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
}
