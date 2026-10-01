export async function onRequest(context) {
  const { request, env } = context;

  // 1. D1 데이터베이스 바인딩 확인
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "D1 Database 'DB' is not bound." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 2. 데이터 불러오기 (GET)
  if (request.method === "GET") {
    try {
      // 테이블이 없는 경우 자동 생성
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS chronicler_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
      ).run();

      const { results } = await env.DB.prepare(
        "SELECT value FROM chronicler_store WHERE key = 'data_backup'"
      ).all();

      const data = results.length > 0 ? JSON.parse(results[0].value) : {};
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // 3. 데이터 저장하기 (POST)
  if (request.method === "POST") {
    try {
      const body = await request.text();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS chronicler_store (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)"
      ).run();

      await env.DB.prepare(
        "INSERT INTO chronicler_store (key, value, updated_at) VALUES ('data_backup', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(body, Date.now()).run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  return new Response("Method Not Allowed", { status: 405 });
}
