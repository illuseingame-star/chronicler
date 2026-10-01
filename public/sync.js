// [Chronicler - Cloudflare D1 Sync Bridge]
// 기존 React 코드를 보호하며 앱 로딩 전 데이터를 자동 동기화합니다.

(async function () {
  try {
    // 1. 페이지 로드 시 D1 서버에서 최신 데이터 당겨오기 (GET)
    const res = await fetch("/api/mcp");
    if (res.ok) {
      const data = await res.json();
      if (data && data.sessions && data.characters) {
        if (data.sessions.length > 0) {
          localStorage.setItem("chronicler.sessions_v1", JSON.stringify(data.sessions));
        }
        if (data.characters.length > 0) {
          localStorage.setItem("chronicler.characters_v1", JSON.stringify(data.characters));
        }
        if (data.turnsMap) {
          for (const [sId, turns] of Object.entries(data.turnsMap)) {
            localStorage.setItem(`chronicler.turns_v1.${sId}`, JSON.stringify(turns));
          }
        }
        console.log("✅ [D1 Sync Bridge] 클라우드 D1 동기화 완료");
      }
    }
  } catch (err) {
    console.warn("⚠️ [D1 Sync Bridge] D1 가져오기 실패 (오프라인 모드):", err);
  }
})();

// 2. 사용자가 대화하거나 설정 변경 시 백그라운드로 D1 백업 (POST)
window.addEventListener("beforeunload", function () {
  try {
    const sessions = JSON.parse(localStorage.getItem("chronicler.sessions_v1") || "[]");
    const characters = JSON.parse(localStorage.getItem("chronicler.characters_v1") || "[]");
    const turnsMap = {};

    for (const s of sessions) {
      const turns = localStorage.getItem(`chronicler.turns_v1.${s.id}`);
      if (turns) turnsMap[s.id] = JSON.parse(turns);
    }

    if (sessions.length > 0 || characters.length > 0) {
      const payload = JSON.stringify({ sessions, characters, turnsMap });
      navigator.sendBeacon("/api/mcp", payload);
    }
  } catch (e) {
    // ignore
  }
});
